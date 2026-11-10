"""Connectors: let Qwen use the owner's Google, Microsoft and X accounts.

- Sign-in is OAuth 2.0 with PKCE, using developer apps the owner creates (client IDs are theirs).
- Client IDs and tokens are kept in the macOS login Keychain, never in plain files.
- server.py only exposes this to the owner (this Mac, or the owner's own Tailscale devices),
  never on the public link.
- Reading (search mail, list events, read files) runs straight away. Anything that sends,
  invites or posts is a "write" tool: the page shows an exact preview and the owner approves it.
Only the Python standard library is used.
"""
import base64
import datetime as dt
import hashlib
import html
import json
import os
import re
import secrets
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from email.utils import getaddresses

CALLBACK_PATH = "/connectors/callback"
PORT = 8766  # set by server.py; redirect URIs point at this Mac's local listener
MAX_RESULT = 12000  # characters of tool output handed to the model
MAX_DOWNLOAD = 20 * 1024 * 1024
UA = "QwenChat/1.0 (local assistant)"


class ConnectorError(Exception):
    pass


# ---------------------------------------------------------------- providers

PROVIDERS = {
    "google": {
        "name": "Google",
        "products": "Gmail, Google Calendar, Google Drive",
        "auth": "https://accounts.google.com/o/oauth2/v2/auth",
        "token": "https://oauth2.googleapis.com/token",
        "revoke": "https://oauth2.googleapis.com/revoke",
        "scopes": [
            "openid", "email",
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/calendar.events",
            "https://www.googleapis.com/auth/drive.readonly",
        ],
        "extra_auth": {"access_type": "offline", "prompt": "consent"},
        "redirect_host": "localhost",
        "secret": "required",
    },
    "microsoft": {
        "name": "Microsoft",
        "products": "Outlook mail, Outlook Calendar, OneDrive",
        "auth": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "token": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        "scopes": ["offline_access", "openid", "email", "User.Read", "Mail.Read", "Mail.Send", "Calendars.ReadWrite", "Files.Read"],
        "extra_auth": {"prompt": "select_account"},
        "redirect_host": "localhost",
        "secret": "none",
    },
    "x": {
        "name": "X",
        "products": "Post to X; read and search posts (reading needs a paid X API plan)",
        "auth": "https://x.com/i/oauth2/authorize",
        "token": "https://api.x.com/2/oauth2/token",
        "revoke": "https://api.x.com/2/oauth2/revoke",
        "scopes": ["tweet.read", "tweet.write", "users.read", "offline.access"],
        "extra_auth": {},
        "redirect_host": "127.0.0.1",  # X doesn't accept "localhost" callback URLs
        "secret": "optional",
    },
}


def redirect_uri(pid):
    return f"http://{PROVIDERS[pid]['redirect_host']}:{PORT}{CALLBACK_PATH}"


# ---------------------------------------------------------------- Keychain storage

KC_SERVICE = "Qwen Chat connector"
_store = None  # tests set a dict here instead of using the Keychain
_lock = threading.Lock()


def _kc_get(account):
    if _store is not None:
        return _store.get(account)
    r = subprocess.run(["security", "find-generic-password", "-s", KC_SERVICE, "-a", account, "-w"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return None
    out = r.stdout.rstrip("\n")
    # `security` prints values containing non-ASCII bytes as hex; turn those back into text
    if out and len(out) % 2 == 0 and re.fullmatch(r"[0-9a-f]+", out):
        try:
            decoded = bytes.fromhex(out).decode("utf-8")
            if decoded[:1] in "{[":
                return decoded
        except ValueError:
            pass
    return out


def _kc_set(account, value):
    if _store is not None:
        _store[account] = value
        return
    r = subprocess.run(["security", "add-generic-password", "-U", "-s", KC_SERVICE, "-a", account, "-w", value],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise ConnectorError("Couldn't save to the macOS Keychain: " + (r.stderr.strip() or f"code {r.returncode}"))


def _kc_del(account):
    if _store is not None:
        _store.pop(account, None)
        return
    subprocess.run(["security", "delete-generic-password", "-s", KC_SERVICE, "-a", account], capture_output=True)


def _load(pid, kind):
    raw = _kc_get(f"{pid}.{kind}")
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


def _save(pid, kind, obj):
    _kc_set(f"{pid}.{kind}", json.dumps(obj))


# ---------------------------------------------------------------- HTTP

def _http(method, url, *, params=None, form=None, body=None, headers=None, timeout=30, limit=4 * 1024 * 1024):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params, doseq=True)
    data, h = None, {"User-Agent": UA, "Accept": "application/json"}
    if body is not None:
        data, h["Content-Type"] = json.dumps(body).encode(), "application/json"
    elif form is not None:
        data, h["Content-Type"] = urllib.parse.urlencode(form).encode(), "application/x-www-form-urlencoded"
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(limit), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(65536), e.headers
    except urllib.error.URLError as e:
        raise ConnectorError(f"Couldn't reach {urllib.parse.urlsplit(url).netloc}: {e.reason}")


def _as_json(content):
    try:
        return json.loads(content or b"{}")
    except ValueError:
        return {}


def _err_text(j, content):
    e = j.get("error") if isinstance(j, dict) else None
    if isinstance(e, dict):
        return e.get("message") or e.get("code") or json.dumps(e)[:300]
    if isinstance(j, dict) and j.get("detail"):
        return str(j.get("detail"))
    if isinstance(j, dict) and (j.get("error_description") or e):
        return str(j.get("error_description") or e)
    return (content or b"")[:300].decode("utf-8", "replace")


# ---------------------------------------------------------------- status and setup

def status():
    out = []
    for pid, p in PROVIDERS.items():
        client = _load(pid, "client")
        token = _load(pid, "token")
        out.append({
            "id": pid, "name": p["name"], "products": p["products"],
            "configured": bool(client and client.get("client_id")),
            "connected": bool(token and token.get("refresh_token") or token and token.get("access_token")),
            "account": (token or {}).get("account", ""),
            "redirect_uri": redirect_uri(pid),
            "secret": p["secret"],
            "scopes": p["scopes"],
        })
    return out


def connected():
    return [s["id"] for s in status() if s["connected"]]


def save_client(pid, client_id, client_secret=""):
    if pid not in PROVIDERS:
        raise ConnectorError("unknown provider")
    client_id, client_secret = (client_id or "").strip(), (client_secret or "").strip()
    if not client_id or len(client_id) > 300 or re.search(r"\s", client_id):
        raise ConnectorError("That doesn't look like a client ID")
    if len(client_secret) > 300 or re.search(r"\s", client_secret):
        raise ConnectorError("That doesn't look like a client secret")
    if PROVIDERS[pid]["secret"] == "required" and not client_secret:
        raise ConnectorError(f"{PROVIDERS[pid]['name']} also needs the client secret")
    with _lock:
        _save(pid, "client", {"client_id": client_id, "client_secret": client_secret})
        _kc_del(f"{pid}.token")  # a different app means signing in again


def forget(pid):
    if pid not in PROVIDERS:
        raise ConnectorError("unknown provider")
    disconnect(pid)
    _kc_del(f"{pid}.client")


# ---------------------------------------------------------------- OAuth

_pending = {}  # state -> {pid, verifier, created}


def start(pid):
    """Begin sign-in: returns the provider's consent URL (open it in a browser on this Mac)."""
    if pid not in PROVIDERS:
        raise ConnectorError("unknown provider")
    client = _load(pid, "client")
    if not client:
        raise ConnectorError("Set this connector up first (client ID)")
    p = PROVIDERS[pid]
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    now = time.time()
    for s in [s for s, v in _pending.items() if now - v["created"] > 900]:
        _pending.pop(s, None)
    _pending[state] = {"pid": pid, "verifier": verifier, "created": now}
    q = {
        "response_type": "code", "client_id": client["client_id"], "redirect_uri": redirect_uri(pid),
        "scope": " ".join(p["scopes"]), "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256", **p["extra_auth"],
    }
    return p["auth"] + "?" + urllib.parse.urlencode(q)


def _token_request(pid, form):
    client = _load(pid, "client") or {}
    p = PROVIDERS[pid]
    headers = {}
    form = dict(form)
    if pid == "x" and client.get("client_secret"):
        basic = base64.b64encode(f"{client['client_id']}:{client['client_secret']}".encode()).decode()
        headers["Authorization"] = "Basic " + basic
    else:
        form["client_id"] = client.get("client_id", "")
        if client.get("client_secret"):
            form["client_secret"] = client["client_secret"]
    code, content, _ = _http("POST", p["token"], form=form, headers=headers)
    j = _as_json(content)
    if code != 200 or "access_token" not in j:
        raise ConnectorError(f"{p['name']} sign-in failed: {_err_text(j, content)}")
    return j


def finish(state, code, error=""):
    """Handle the redirect back from the provider. Returns (provider name, account)."""
    pend = _pending.pop(state or "", None)
    if not pend or time.time() - pend["created"] > 900:
        raise ConnectorError("This sign-in link expired or was already used. Start again from Connectors.")
    pid = pend["pid"]
    if error:
        raise ConnectorError(f"{PROVIDERS[pid]['name']} sign-in was cancelled ({error})")
    if not code:
        raise ConnectorError("No authorization code came back")
    j = _token_request(pid, {"grant_type": "authorization_code", "code": code,
                             "redirect_uri": redirect_uri(pid), "code_verifier": pend["verifier"]})
    token = {"access_token": j["access_token"], "refresh_token": j.get("refresh_token", ""),
             "expires_at": time.time() + int(j.get("expires_in") or 3600) - 60}
    with _lock:
        _save(pid, "token", token)
    try:
        who = _identity(pid)
    except ConnectorError:
        who = {}
    token.update(who)
    with _lock:
        _save(pid, "token", token)
    return PROVIDERS[pid]["name"], token.get("account", "")


def _identity(pid):
    if pid == "google":
        j = _api(pid, "GET", "https://openidconnect.googleapis.com/v1/userinfo")
        return {"account": j.get("email", "")}
    if pid == "microsoft":
        j = _api(pid, "GET", "https://graph.microsoft.com/v1.0/me", params={"$select": "mail,userPrincipalName,displayName"})
        return {"account": j.get("mail") or j.get("userPrincipalName", "")}
    if pid == "x":
        j = _api(pid, "GET", "https://api.x.com/2/users/me")
        d = j.get("data") or {}
        return {"account": "@" + d.get("username", "") if d.get("username") else "", "user_id": d.get("id", "")}
    return {}


def disconnect(pid):
    if pid not in PROVIDERS:
        raise ConnectorError("unknown provider")
    token = _load(pid, "token")
    _kc_del(f"{pid}.token")
    revoke = PROVIDERS[pid].get("revoke")
    if token and revoke:  # best effort: also tell the provider to drop the grant
        try:
            t = token.get("refresh_token") or token.get("access_token")
            form = {"token": t}
            if pid == "x":
                form["client_id"] = (_load(pid, "client") or {}).get("client_id", "")
            _http("POST", revoke, form=form, timeout=10)
        except Exception:
            pass


def _access_token(pid, force=False):
    with _lock:
        token = _load(pid, "token")
        if not token:
            raise ConnectorError(f"{PROVIDERS[pid]['name']} isn't connected. Connect it in Connectors (profile menu).")
        if not force and token.get("access_token") and time.time() < token.get("expires_at", 0):
            return token["access_token"]
        if not token.get("refresh_token"):
            raise ConnectorError(f"Your {PROVIDERS[pid]['name']} sign-in expired. Reconnect it in Connectors.")
        try:
            j = _token_request(pid, {"grant_type": "refresh_token", "refresh_token": token["refresh_token"]})
        except ConnectorError as e:
            raise ConnectorError(f"Your {PROVIDERS[pid]['name']} sign-in expired or was revoked. Reconnect it in Connectors. ({e})")
        token["access_token"] = j["access_token"]
        token["expires_at"] = time.time() + int(j.get("expires_in") or 3600) - 60
        if j.get("refresh_token"):  # Microsoft and X rotate refresh tokens
            token["refresh_token"] = j["refresh_token"]
        _save(pid, "token", token)
        return token["access_token"]


def _api(pid, method, url, *, params=None, body=None, headers=None, raw=False, limit=4 * 1024 * 1024):
    for attempt in (0, 1):
        h = {"Authorization": "Bearer " + _access_token(pid, force=attempt == 1), **(headers or {})}
        code, content, resp_headers = _http(method, url, params=params, body=body, headers=h, limit=limit)
        if code == 401 and attempt == 0:
            continue  # token may have just expired: refresh once and retry
        if code >= 400:
            j = _as_json(content)
            msg = _err_text(j, content)
            if pid == "x" and code in (401, 403, 429):
                raise ConnectorError(f"X refused this ({code}): {msg}. Reading or searching posts needs a paid X API plan; "
                                     "posting works on the free plan within its monthly limit.")
            raise ConnectorError(f"{PROVIDERS[pid]['name']} returned {code}: {msg}")
        if raw:
            return content, resp_headers
        return _as_json(content) if content else {}
    raise ConnectorError("unreachable")


# ---------------------------------------------------------------- helpers for tools

def _local_tz():
    path = os.path.realpath("/etc/localtime")
    return path.split("zoneinfo/", 1)[1] if "zoneinfo/" in path else "UTC"


def _when(text, default=None, end_of_day=False):
    """'2026-11-08', '2026-11-08 14:30', ISO with offset → aware datetime (naive = this Mac's local time).
    end_of_day: a bare date used as an end means "through that day"."""
    t = (text or "").strip().replace("Z", "+00:00")
    if not t:
        if default is None:
            raise ConnectorError("a date/time is required")
        return default
    if len(t) > 10 and t[10] == " ":
        t = t[:10] + "T" + t[11:]
    try:
        d = dt.datetime.fromisoformat(t)
    except ValueError:
        raise ConnectorError(f"Couldn't read the date/time '{text}'. Use a form like 2026-11-08 or 2026-11-08 14:30.")
    if d.tzinfo is None:
        d = d.astimezone()
    if end_of_day and len(t) == 10:
        d += dt.timedelta(days=1)
    return d


def _clip(text, n=MAX_RESULT):
    text = text.strip()
    return text if len(text) <= n else text[:n] + f"\n… [cut at {n} characters]"


def _strip_html(s):
    s = re.sub(r"(?is)<(script|style|head).*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</li>", "\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s))
    return re.sub(r"[ \t\r\f\v]+", " ", re.sub(r"\n\s*\n+", "\n\n", s)).strip()


_ID = re.compile(r"^[A-Za-z0-9_\-=.!]{1,512}$")


def _id(v, what="id"):
    v = str(v or "").strip()
    if not _ID.match(v):
        raise ConnectorError(f"That {what} isn't valid — use an id from a search result")
    return v


def _emails(text, what="to"):
    pairs = [(n, a) for n, a in getaddresses([str(text or "")]) if a]
    bad = [a for _, a in pairs if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", a)]
    if bad:
        raise ConnectorError(f"Not an email address: {', '.join(bad)}")
    if what == "to" and not pairs:
        raise ConnectorError("Who should this go to? Give at least one email address.")
    return [a for _, a in pairs]


def _num(v, default, lo=1, hi=25):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def _doc_text(name, content):
    """Text from a downloaded file: PDFs and Word documents via codetools, else UTF-8."""
    ext = os.path.splitext(name or "")[1].lower()
    if ext in (".pdf", ".docx", ".doc", ".rtf", ".odt", ".pages"):
        import codetools  # PDFKit / textutil readers already used by Code mode
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "file" + ext)
            with open(p, "wb") as f:
                f.write(content)
            return codetools.read_document(p)
    if b"\x00" in content[:4096]:
        raise ConnectorError(f"{name} is a binary file; I can only read text, PDF and Word documents")
    return content.decode("utf-8", "replace")


def _account(pid):
    return (_load(pid, "token") or {}).get("account", "")


# ---------------------------------------------------------------- Google

G_MAIL = "https://gmail.googleapis.com/gmail/v1/users/me"


def _hdr(headers, name):
    for h in headers or []:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def gmail_search(query="", max_results=10):
    j = _api("google", "GET", G_MAIL + "/messages", params={"q": query or "in:inbox", "maxResults": _num(max_results, 10)})
    ids = [m["id"] for m in j.get("messages", [])]
    if not ids:
        return f"No emails match {query!r}."
    # Gmail's resultSizeEstimate can be far off, so count exactly by paging through ids (cheap)
    total, capped = len(ids), False
    if j.get("nextPageToken"):
        total, token = 0, None
        while True:
            p = {"q": query or "in:inbox", "maxResults": 500, "fields": "messages/id,nextPageToken"}
            if token:
                p["pageToken"] = token
            page = _api("google", "GET", G_MAIL + "/messages", params=p)
            total += len(page.get("messages", []))
            token = page.get("nextPageToken")
            if not token:
                break
            if total >= 5000:
                capped = True
                break
    lines = [f"{total}{'+' if capped else ''} email(s) match in total; showing the newest {len(ids)}:"]
    for mid in ids:
        m = _api("google", "GET", f"{G_MAIL}/messages/{mid}",
                 params={"format": "metadata", "metadataHeaders": ["From", "Subject", "Date"]})
        h = m.get("payload", {}).get("headers", [])
        lines.append(f"[{mid}] {_hdr(h, 'Date')} | From: {_hdr(h, 'From')} | Subject: {_hdr(h, 'Subject')}\n    {html.unescape(m.get('snippet', ''))}")
    return _clip("\n".join(lines))


def _gmail_body(part):
    plain, htm = [], []

    def walk(p):
        mt, data = p.get("mimeType", ""), (p.get("body") or {}).get("data")
        if data and mt == "text/plain":
            plain.append(base64.urlsafe_b64decode(data + "==").decode("utf-8", "replace"))
        elif data and mt == "text/html":
            htm.append(base64.urlsafe_b64decode(data + "==").decode("utf-8", "replace"))
        for c in p.get("parts", []) or []:
            walk(c)
    walk(part)
    return "\n".join(plain) if plain else _strip_html("\n".join(htm))


def gmail_read(message_id):
    m = _api("google", "GET", f"{G_MAIL}/messages/{_id(message_id, 'email id')}", params={"format": "full"})
    h = m.get("payload", {}).get("headers", [])
    head = "\n".join(f"{k}: {_hdr(h, k)}" for k in ("From", "To", "Cc", "Date", "Subject") if _hdr(h, k))
    return _clip(head + "\n\n" + _gmail_body(m.get("payload", {})))


def _mail_preview(pid, to, subject, body, cc=""):
    lines = [f"From: {_account(pid)}", f"To: {', '.join(_emails(to))}"]
    if cc:
        lines.append(f"Cc: {', '.join(_emails(cc, 'cc'))}")
    lines += [f"Subject: {subject or '(no subject)'}", "", str(body or "")]
    return "\n".join(lines)


def gmail_send(to, subject, body, cc="", dry_run=True):
    preview = _mail_preview("google", to, subject, body, cc)
    if dry_run:
        return {"preview": preview}
    msg = EmailMessage()
    msg["To"] = ", ".join(_emails(to))
    if cc:
        msg["Cc"] = ", ".join(_emails(cc, "cc"))
    msg["Subject"] = subject or ""
    msg.set_content(str(body or ""))
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    r = _api("google", "POST", G_MAIL + "/messages/send", body={"raw": raw})
    return f"Sent (Gmail message id {r.get('id', '?')}) to {msg['To']}."


G_CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"


def _fmt_range(start, end, all_day):
    if all_day:
        return f"{start} (all day)"
    try:
        s, e = dt.datetime.fromisoformat(start.replace("Z", "+00:00")).astimezone(), dt.datetime.fromisoformat(end.replace("Z", "+00:00")).astimezone()
        return f"{s:%a %d %b %Y %H:%M}–{e:%H:%M}" if s.date() == e.date() else f"{s:%a %d %b %H:%M} – {e:%a %d %b %H:%M}"
    except ValueError:
        return f"{start} – {end}"


def calendar_events(start="", end="", query="", max_results=20):
    s = _when(start, dt.datetime.now().astimezone())
    e = _when(end, s + dt.timedelta(days=7), end_of_day=True)
    params = {"timeMin": s.isoformat(), "timeMax": e.isoformat(), "singleEvents": "true", "orderBy": "startTime",
              "maxResults": _num(max_results, 20, hi=50)}
    if query:
        params["q"] = query
    j = _api("google", "GET", G_CAL, params=params)
    items = j.get("items", [])
    if not items:
        return f"No events between {s:%d %b %H:%M} and {e:%d %b %H:%M}."
    out = []
    for it in items:
        st, en = it.get("start", {}), it.get("end", {})
        when = _fmt_range(st.get("dateTime") or st.get("date", ""), en.get("dateTime") or en.get("date", ""), "date" in st)
        loc = f" @ {it['location']}" if it.get("location") else ""
        out.append(f"[{it.get('id')}] {when} | {it.get('summary', '(no title)')}{loc}")
    return _clip("\n".join(out))


def _event_preview(pid, title, s, e, description, location, attendees):
    lines = [f"Calendar: {_account(pid)}", f"Title: {title}", f"When: {s:%a %d %b %Y %H:%M} – {e:%a %d %b %Y %H:%M} ({_local_tz()})"]
    if location:
        lines.append(f"Where: {location}")
    if attendees:
        lines.append(f"Invitations will be emailed to: {', '.join(attendees)}")
    if description:
        lines += ["", str(description)]
    return "\n".join(lines)


def _event_args(title, start, end):
    if not (title or "").strip():
        raise ConnectorError("The event needs a title")
    s = _when(start)
    e = _when(end, s + dt.timedelta(hours=1))
    if e <= s:
        raise ConnectorError("The event must end after it starts")
    return title.strip(), s, e


def calendar_create(title, start, end="", description="", location="", attendees="", dry_run=True):
    title, s, e = _event_args(title, start, end)
    people = _emails(attendees, "attendees") if attendees else []
    if dry_run:
        return {"preview": _event_preview("google", title, s, e, description, location, people)}
    tz = _local_tz()
    ev = {"summary": title, "start": {"dateTime": s.isoformat(), "timeZone": tz}, "end": {"dateTime": e.isoformat(), "timeZone": tz}}
    if description:
        ev["description"] = description
    if location:
        ev["location"] = location
    if people:
        ev["attendees"] = [{"email": a} for a in people]
    r = _api("google", "POST", G_CAL, params={"sendUpdates": "all" if people else "none"}, body=ev)
    return f"Created “{title}” on {s:%a %d %b %H:%M}. Link: {r.get('htmlLink', '')}"


G_DRIVE = "https://www.googleapis.com/drive/v3/files"
G_EXPORT = {"application/vnd.google-apps.document": "text/plain", "application/vnd.google-apps.spreadsheet": "text/csv",
            "application/vnd.google-apps.presentation": "text/plain"}


def drive_search(query, max_results=10):
    q = (query or "").replace("\\", "\\\\").replace("'", "\\'")
    if not q.strip():
        raise ConnectorError("What should I search Drive for?")
    j = _api("google", "GET", G_DRIVE, params={
        "q": f"(name contains '{q}' or fullText contains '{q}') and trashed = false",
        "pageSize": _num(max_results, 10), "fields": "files(id,name,mimeType,modifiedTime,webViewLink,size)"})
    files = j.get("files", [])
    if not files:
        return f"No Drive files match {query!r}."
    return _clip("\n".join(f"[{f['id']}] {f.get('name')} ({f.get('mimeType', '').split('.')[-1].split('/')[-1]}, modified {f.get('modifiedTime', '')[:10]}) {f.get('webViewLink', '')}" for f in files))


def drive_read(file_id):
    fid = _id(file_id, "file id")
    meta = _api("google", "GET", f"{G_DRIVE}/{fid}", params={"fields": "name,mimeType,size"})
    name, mt = meta.get("name", "file"), meta.get("mimeType", "")
    if mt in G_EXPORT:
        content, _ = _api("google", "GET", f"{G_DRIVE}/{fid}/export", params={"mimeType": G_EXPORT[mt]}, raw=True, limit=MAX_DOWNLOAD)
        text = content.decode("utf-8", "replace")
    elif mt.startswith("application/vnd.google-apps"):
        raise ConnectorError(f"{name} is a {mt.rsplit('.', 1)[-1]}, which I can't read as text")
    else:
        if int(meta.get("size") or 0) > MAX_DOWNLOAD:
            raise ConnectorError(f"{name} is larger than 20 MB")
        content, _ = _api("google", "GET", f"{G_DRIVE}/{fid}", params={"alt": "media"}, raw=True, limit=MAX_DOWNLOAD)
        text = _doc_text(name, content)
    return _clip(f"{name}\n\n{text}")


# ---------------------------------------------------------------- Microsoft (Graph)

GRAPH = "https://graph.microsoft.com/v1.0"


def _ms_who(x):
    a = (x or {}).get("emailAddress") or {}
    return f"{a.get('name', '')} <{a.get('address', '')}>".strip()


def outlook_search(query="", max_results=10):
    sel = "id,subject,from,receivedDateTime,bodyPreview"
    if query:
        j = _api("microsoft", "GET", GRAPH + "/me/messages", params={"$search": f'"{query.replace(chr(34), "")}"', "$top": _num(max_results, 10), "$select": sel})
    else:
        j = _api("microsoft", "GET", GRAPH + "/me/mailFolders/inbox/messages",
                 params={"$top": _num(max_results, 10), "$select": sel, "$orderby": "receivedDateTime desc"})
    items = j.get("value", [])
    if not items:
        return f"No emails match {query!r}." if query else "Your inbox is empty."
    return _clip("\n".join(f"[{m['id']}] {m.get('receivedDateTime', '')[:16].replace('T', ' ')} | From: {_ms_who(m.get('from'))} | Subject: {m.get('subject', '')}\n    {m.get('bodyPreview', '')[:200]}" for m in items))


def outlook_read(message_id):
    m = _api("microsoft", "GET", f"{GRAPH}/me/messages/{urllib.parse.quote(_id(message_id, 'email id'), safe='')}",
             params={"$select": "subject,from,toRecipients,ccRecipients,receivedDateTime,body"},
             headers={"Prefer": 'outlook.body-content-type="text"'})
    head = [f"From: {_ms_who(m.get('from'))}", "To: " + ", ".join(_ms_who(x) for x in m.get("toRecipients", []))]
    if m.get("ccRecipients"):
        head.append("Cc: " + ", ".join(_ms_who(x) for x in m["ccRecipients"]))
    head += [f"Date: {m.get('receivedDateTime', '')}", f"Subject: {m.get('subject', '')}"]
    return _clip("\n".join(head) + "\n\n" + ((m.get("body") or {}).get("content") or ""))


def outlook_send(to, subject, body, cc="", dry_run=True):
    preview = _mail_preview("microsoft", to, subject, body, cc)
    if dry_run:
        return {"preview": preview}
    msg = {"subject": subject or "", "body": {"contentType": "Text", "content": str(body or "")},
           "toRecipients": [{"emailAddress": {"address": a}} for a in _emails(to)]}
    if cc:
        msg["ccRecipients"] = [{"emailAddress": {"address": a}} for a in _emails(cc, "cc")]
    _api("microsoft", "POST", GRAPH + "/me/sendMail", body={"message": msg, "saveToSentItems": True})
    return f"Sent to {', '.join(_emails(to))}."


def outlook_calendar_events(start="", end="", max_results=25):
    s = _when(start, dt.datetime.now().astimezone())
    e = _when(end, s + dt.timedelta(days=7), end_of_day=True)
    j = _api("microsoft", "GET", GRAPH + "/me/calendarView", params={
        "startDateTime": s.isoformat(), "endDateTime": e.isoformat(), "$top": _num(max_results, 25, hi=50),
        "$orderby": "start/dateTime", "$select": "id,subject,start,end,location,isAllDay"},
        headers={"Prefer": f'outlook.timezone="{_local_tz()}"'})
    items = j.get("value", [])
    if not items:
        return f"No events between {s:%d %b %H:%M} and {e:%d %b %H:%M}."
    out = []
    for it in items:
        when = f"{it['start']['dateTime'][:16].replace('T', ' ')} – {it['end']['dateTime'][11:16]}" if not it.get("isAllDay") else f"{it['start']['dateTime'][:10]} (all day)"
        loc = (it.get("location") or {}).get("displayName")
        out.append(f"[{it['id']}] {when} | {it.get('subject', '(no title)')}{' @ ' + loc if loc else ''}")
    return _clip("\n".join(out))


def outlook_calendar_create(title, start, end="", description="", location="", attendees="", dry_run=True):
    title, s, e = _event_args(title, start, end)
    people = _emails(attendees, "attendees") if attendees else []
    if dry_run:
        return {"preview": _event_preview("microsoft", title, s, e, description, location, people)}
    tz = _local_tz()
    ev = {"subject": title, "start": {"dateTime": s.strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": tz},
          "end": {"dateTime": e.astimezone(s.tzinfo).strftime("%Y-%m-%dT%H:%M:%S"), "timeZone": tz}}
    if description:
        ev["body"] = {"contentType": "Text", "content": description}
    if location:
        ev["location"] = {"displayName": location}
    if people:
        ev["attendees"] = [{"emailAddress": {"address": a}, "type": "required"} for a in people]
    r = _api("microsoft", "POST", GRAPH + "/me/events", body=ev)
    return f"Created “{title}” on {s:%a %d %b %H:%M}. Link: {r.get('webLink', '')}"


def onedrive_search(query, max_results=10):
    if not (query or "").strip():
        raise ConnectorError("What should I search OneDrive for?")
    q = query.replace("'", "''")
    j = _api("microsoft", "GET", f"{GRAPH}/me/drive/root/search(q='{urllib.parse.quote(q, safe='')}')",
             params={"$top": _num(max_results, 10), "$select": "id,name,file,folder,webUrl,lastModifiedDateTime,size"})
    items = j.get("value", [])
    if not items:
        return f"No OneDrive files match {query!r}."
    return _clip("\n".join(f"[{f['id']}] {f.get('name')} ({'folder' if f.get('folder') else (f.get('file') or {}).get('mimeType', 'file')}, modified {f.get('lastModifiedDateTime', '')[:10]}) {f.get('webUrl', '')}" for f in items))


def onedrive_read(file_id):
    fid = urllib.parse.quote(_id(file_id, "file id"), safe="")
    meta = _api("microsoft", "GET", f"{GRAPH}/me/drive/items/{fid}")
    name = meta.get("name", "file")
    if meta.get("folder"):
        raise ConnectorError(f"{name} is a folder")
    if int(meta.get("size") or 0) > MAX_DOWNLOAD:
        raise ConnectorError(f"{name} is larger than 20 MB")
    url = meta.get("@microsoft.graph.downloadUrl")
    if not url:
        raise ConnectorError(f"OneDrive gave no download link for {name}")
    code, content, _ = _http("GET", url, timeout=60, limit=MAX_DOWNLOAD)  # pre-signed: no token sent along
    if code >= 400:
        raise ConnectorError(f"Download of {name} failed ({code})")
    return _clip(f"{name}\n\n{_doc_text(name, content)}")


# ---------------------------------------------------------------- X

X_API = "https://api.x.com/2"


def _x_lines(j):
    users = {u["id"]: u.get("username", "") for u in (j.get("includes") or {}).get("users", [])}
    rows = []
    for t in j.get("data") or []:
        who = users.get(t.get("author_id"), "")
        rows.append(f"[{t['id']}] {t.get('created_at', '')[:16].replace('T', ' ')} {'@' + who if who else ''}: {t.get('text', '')}")
    return rows


def x_post(text, dry_run=True):
    text = str(text or "").strip()
    if not text:
        raise ConnectorError("The post is empty")
    if len(text) > 280:
        raise ConnectorError(f"That's {len(text)} characters; X allows 280. Shorten it.")
    if dry_run:
        return {"preview": f"Post publicly on X as {_account('x') or 'your account'}:\n\n{text}"}
    r = _api("x", "POST", X_API + "/tweets", body={"text": text})
    pid = (r.get("data") or {}).get("id", "")
    handle = _account("x").lstrip("@") or "i"
    return f"Posted: https://x.com/{handle}/status/{pid}"


def x_search(query, max_results=10):
    if not (query or "").strip():
        raise ConnectorError("What should I search X for?")
    j = _api("x", "GET", X_API + "/tweets/search/recent", params={
        "query": query, "max_results": _num(max_results, 10, lo=10, hi=50),
        "tweet.fields": "created_at,author_id", "expansions": "author_id", "user.fields": "username"})
    rows = _x_lines(j)
    return _clip("\n".join(rows)) if rows else f"No recent posts match {query!r}."


def x_my_posts(max_results=10):
    uid = (_load("x", "token") or {}).get("user_id") or (_api("x", "GET", X_API + "/users/me").get("data") or {}).get("id")
    j = _api("x", "GET", f"{X_API}/users/{_id(uid, 'user id')}/tweets", params={
        "max_results": _num(max_results, 10, lo=5, hi=50), "tweet.fields": "created_at"})
    rows = _x_lines(j)
    return _clip("\n".join(rows)) if rows else "You have no recent posts."


# ---------------------------------------------------------------- tool registry

def _p(**props):
    req = [k for k, v in props.items() if not v.startswith("(optional)")]
    return {"type": "object", "properties": {k: {"type": "integer" if k == "max_results" else "string",
                                                 "description": v.replace("(optional) ", "")} for k, v in props.items()},
            "required": req}


TOOLS = {
    # name: (provider, function, writes?, description, parameters)
    "gmail_search": ("google", gmail_search, False, "Search the user's Gmail with Gmail search syntax: from:, to:, subject:, is:unread, has:attachment, newer_than:7d (also 2d, 1m), after:2026/11/01 (slashes, not dashes). The first line gives how many emails match in total, so use it to answer 'how many' questions. Then ids, senders, subjects and snippets.",
                     _p(query="(optional) Gmail search query; empty = latest inbox", max_results="(optional) how many, default 10")),
    "gmail_read": ("google", gmail_read, False, "Read one Gmail email in full by its id (from gmail_search).", _p(message_id="email id")),
    "gmail_send": ("google", gmail_send, True, "Send an email from the user's Gmail. The user sees the exact email and must approve it.",
                   _p(to="recipient email address(es), comma-separated", subject="subject line", body="plain-text body", cc="(optional) cc addresses")),
    "calendar_events": ("google", calendar_events, False, "List events in the user's Google Calendar. Dates like 2026-11-08 or 2026-11-08 14:30 (local time). Default: the next 7 days.",
                        _p(start="(optional) from", end="(optional) until", query="(optional) text to match", max_results="(optional) how many, default 20")),
    "calendar_create": ("google", calendar_create, True, "Create an event in the user's Google Calendar (local time). Attendees get email invitations. The user approves first.",
                        _p(title="event title", start="start, e.g. 2026-11-08 14:30", end="(optional) end; default one hour later", description="(optional) notes", location="(optional) place", attendees="(optional) emails to invite")),
    "drive_search": ("google", drive_search, False, "Search the user's Google Drive by file name and content.", _p(query="words to find", max_results="(optional) how many, default 10")),
    "drive_read": ("google", drive_read, False, "Read a Google Drive file as text (Docs, Sheets as CSV, Slides, PDF, Word, text) by id from drive_search.", _p(file_id="file id")),
    "outlook_search": ("microsoft", outlook_search, False, "Search the user's Outlook / Microsoft mail. Empty query = latest inbox.",
                       _p(query="(optional) words to search", max_results="(optional) how many, default 10")),
    "outlook_read": ("microsoft", outlook_read, False, "Read one Outlook email in full by id (from outlook_search).", _p(message_id="email id")),
    "outlook_send": ("microsoft", outlook_send, True, "Send an email from the user's Outlook. The user sees the exact email and must approve it.",
                     _p(to="recipient email address(es), comma-separated", subject="subject line", body="plain-text body", cc="(optional) cc addresses")),
    "outlook_calendar_events": ("microsoft", outlook_calendar_events, False, "List events in the user's Outlook calendar. Default: the next 7 days.",
                                _p(start="(optional) from, e.g. 2026-11-08", end="(optional) until", max_results="(optional) how many, default 25")),
    "outlook_calendar_create": ("microsoft", outlook_calendar_create, True, "Create an event in the user's Outlook calendar (local time). Attendees get invitations. The user approves first.",
                                _p(title="event title", start="start, e.g. 2026-11-08 14:30", end="(optional) end; default one hour later", description="(optional) notes", location="(optional) place", attendees="(optional) emails to invite")),
    "onedrive_search": ("microsoft", onedrive_search, False, "Search the user's OneDrive files.", _p(query="words to find", max_results="(optional) how many, default 10")),
    "onedrive_read": ("microsoft", onedrive_read, False, "Read a OneDrive file as text (Word, PDF, text, CSV) by id from onedrive_search.", _p(file_id="file id")),
    "x_post": ("x", x_post, True, "Publish a post on X from the user's account (max 280 characters). Public. The user approves the exact text first.", _p(text="the post")),
    "x_search": ("x", x_search, False, "Search recent public posts on X (needs a paid X API plan).", _p(query="X search query", max_results="(optional) 10-50")),
    "x_my_posts": ("x", x_my_posts, False, "List the user's own recent posts on X (needs read access on the X API plan).", _p(max_results="(optional) how many")),
}


def tool_schemas(providers=None):
    """Ollama tool definitions for the connected providers (or the given ones)."""
    have = set(connected() if providers is None else providers)
    return [{"type": "function", "function": {"name": n, "description": d, "parameters": params}}
            for n, (pid, _, _, d, params) in TOOLS.items() if pid in have]


def write_tools():
    return [n for n, t in TOOLS.items() if t[2]]


def call(name, args, dry_run=True):
    if name not in TOOLS:
        raise ConnectorError(f"unknown tool {name}")
    pid, fn, writes, _, params = TOOLS[name]
    if not isinstance(args, dict):
        args = {}
    allowed = set(params["properties"])
    kwargs = {k: v for k, v in args.items() if k in allowed}
    missing = [k for k in params["required"] if not str(kwargs.get(k, "")).strip()]
    if missing:
        raise ConnectorError(f"missing: {', '.join(missing)}")
    if writes:
        out = fn(**kwargs, dry_run=bool(dry_run))
        return out if isinstance(out, dict) else {"result": out}
    return {"result": fn(**kwargs)}
