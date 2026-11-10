"""Offline tests for connectors.py: a fake HTTP layer stands in for Google, Microsoft and X.
Run:  python3 -m unittest tests/test_connectors.py   (from the qwen-chat folder)"""
import base64
import json
import os
import sys
import time
import unittest
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import connectors as C  # noqa: E402


class FakeHTTP:
    """Records requests; answers from a list of (match, status, body) rules."""

    def __init__(self):
        self.calls, self.rules = [], []

    def on(self, method, url_part, status=200, body=None, raw=None):
        self.rules.append((method, url_part, status, body, raw))

    def __call__(self, method, url, *, params=None, form=None, body=None, headers=None, timeout=30, limit=0):
        full = url + ("?" + urllib.parse.urlencode(params, doseq=True) if params else "")
        self.calls.append({"method": method, "url": url, "full": full, "params": params or {}, "form": form,
                           "body": body, "headers": headers or {}})
        for i, (m, part, status, b, raw) in enumerate(self.rules):
            if m == method and part in full:
                content = raw if raw is not None else json.dumps(b if b is not None else {}).encode()
                return status, content, {}
        raise AssertionError(f"unexpected request {method} {full}")

    def last(self, url_part):
        return [c for c in self.calls if url_part in c["full"]][-1]


def connect(pid, http, account_body=None, secret="sec"):
    C.save_client(pid, "cid-" + pid, secret if C.PROVIDERS[pid]["secret"] != "none" else "")
    url = C.start(pid)
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    http.on("POST", C.PROVIDERS[pid]["token"], body={"access_token": "AT1", "refresh_token": "RT1", "expires_in": 3600})
    if account_body is not None:
        for m, part, body in account_body:
            http.on(m, part, body=body)
    return C.finish(q["state"][0], "CODE"), q, url


class Base(unittest.TestCase):
    def setUp(self):
        C._store = {}
        C._pending.clear()
        C.PORT = 8766
        self.http = FakeHTTP()
        self._orig = C._http
        C._http = self.http

    def tearDown(self):
        C._http = self._orig
        C._store = None


class OAuthTests(Base):
    def test_google_needs_secret(self):
        with self.assertRaises(C.ConnectorError):
            C.save_client("google", "abc.apps.googleusercontent.com", "")

    def test_bad_client_id(self):
        with self.assertRaises(C.ConnectorError):
            C.save_client("microsoft", "has space")

    def test_google_flow(self):
        (name, account), q, url = connect("google", self.http, [("GET", "openidconnect", {"email": "me@gmail.com"})])
        self.assertEqual((name, account), ("Google", "me@gmail.com"))
        self.assertTrue(url.startswith("https://accounts.google.com/o/oauth2/v2/auth?"))
        self.assertEqual(q["code_challenge_method"], ["S256"])
        self.assertEqual(q["redirect_uri"], ["http://localhost:8766/connectors/callback"])
        self.assertEqual(q["access_type"], ["offline"])
        self.assertIn("https://www.googleapis.com/auth/gmail.send", q["scope"][0])
        tok = self.http.last("oauth2.googleapis.com/token")
        self.assertEqual(tok["form"]["grant_type"], "authorization_code")
        self.assertEqual(tok["form"]["client_secret"], "sec")
        self.assertTrue(len(tok["form"]["code_verifier"]) >= 43)
        st = {s["id"]: s for s in C.status()}
        self.assertTrue(st["google"]["connected"])
        self.assertEqual(st["google"]["account"], "me@gmail.com")
        self.assertEqual(C.connected(), ["google"])

    def test_state_single_use(self):
        (_, _), q, _ = connect("google", self.http, [("GET", "openidconnect", {"email": "a@b.co"})])
        with self.assertRaises(C.ConnectorError):
            C.finish(q["state"][0], "CODE")

    def test_unknown_state(self):
        with self.assertRaises(C.ConnectorError):
            C.finish("nope", "CODE")

    def test_microsoft_public_client(self):
        (name, account), q, _ = connect("microsoft", self.http, [("GET", "graph.microsoft.com/v1.0/me", {"mail": "me@outlook.com"})])
        self.assertEqual(account, "me@outlook.com")
        tok = self.http.last("login.microsoftonline.com")
        self.assertNotIn("client_secret", tok["form"])
        self.assertEqual(tok["form"]["client_id"], "cid-microsoft")

    def test_x_redirect_and_basic_auth(self):
        (name, account), q, _ = connect("x", self.http, [("GET", "api.x.com/2/users/me", {"data": {"id": "42", "username": "pankaj"}})])
        self.assertEqual(q["redirect_uri"], ["http://127.0.0.1:8766/connectors/callback"])
        self.assertEqual(account, "@pankaj")
        tok = self.http.last("api.x.com/2/oauth2/token")
        self.assertTrue(tok["headers"]["Authorization"].startswith("Basic "))
        self.assertNotIn("client_id", tok["form"])

    def test_refresh_and_rotation(self):
        connect("microsoft", self.http, [("GET", "graph.microsoft.com/v1.0/me", {"mail": "me@outlook.com"})])
        t = json.loads(C._store["microsoft.token"]); t["expires_at"] = time.time() - 5; C._store["microsoft.token"] = json.dumps(t)
        self.http.rules.insert(0, ("POST", "login.microsoftonline.com", 200, {"access_token": "AT2", "refresh_token": "RT2", "expires_in": 3600}, None))
        self.http.on("GET", "/me/mailFolders/inbox/messages", body={"value": []})
        C.outlook_search()
        t = json.loads(C._store["microsoft.token"])
        self.assertEqual((t["access_token"], t["refresh_token"]), ("AT2", "RT2"))
        self.assertEqual(self.http.last("inbox/messages")["headers"]["Authorization"], "Bearer AT2")

    def test_401_retries_once_with_refresh(self):
        connect("google", self.http, [("GET", "openidconnect", {"email": "a@b.co"})])
        expired = ("GET", "gmail/v1/users/me/messages?", 401, {"error": {"message": "expired"}}, None)
        self.http.rules.insert(0, expired)
        # after the first 401, swap that rule so the retry succeeds
        orig = self.http.__call__

        def flip(*a, **k):
            r = orig(*a, **k)
            if r[0] == 401:
                self.http.rules[self.http.rules.index(expired)] = ("GET", "gmail/v1/users/me/messages?", 200, {"messages": []}, None)
            return r
        C._http = flip
        self.http.rules.insert(0, ("POST", "oauth2.googleapis.com/token", 200, {"access_token": "AT9", "expires_in": 3600}, None))
        self.assertIn("No emails", C.gmail_search("from:x"))
        t = json.loads(C._store["google.token"])
        self.assertEqual(t["access_token"], "AT9")
        self.assertEqual(t["refresh_token"], "RT1")  # Google doesn't rotate: keep the old one

    def test_disconnect_revokes(self):
        connect("google", self.http, [("GET", "openidconnect", {"email": "a@b.co"})])
        self.http.on("POST", "oauth2.googleapis.com/revoke", body={})
        C.disconnect("google")
        self.assertEqual(C.connected(), [])
        self.assertEqual(self.http.last("revoke")["form"]["token"], "RT1")


class GoogleTools(Base):
    def setUp(self):
        super().setUp()
        connect("google", self.http, [("GET", "openidconnect", {"email": "me@gmail.com"})])

    def test_gmail_search(self):
        self.http.on("GET", "maxResults=500&fields=messages%2Fid%2CnextPageToken&pageToken=p2", body={"messages": [{"id": "z"}] * 7})
        self.http.on("GET", "maxResults=500&fields=messages%2Fid%2CnextPageToken", body={"messages": [{"id": "y"}] * 500, "nextPageToken": "p2"})
        self.http.on("GET", "/messages?q=", body={"messages": [{"id": "m1"}], "resultSizeEstimate": 37, "nextPageToken": "x"})
        self.http.on("GET", "/messages/m1?format=metadata", body={"snippet": "Hi &amp; hello", "payload": {"headers": [
            {"name": "From", "value": "A <a@x.com>"}, {"name": "Subject", "value": "Lunch"}, {"name": "Date", "value": "Fri"}]}})
        out = C.gmail_search("is:unread")
        self.assertIn("[m1] Fri | From: A <a@x.com> | Subject: Lunch", out)
        self.assertIn("Hi & hello", out)
        self.assertIn("507 email(s) match in total", out)
        self.assertIn("metadataHeaders=From&metadataHeaders=Subject", self.http.last("format=metadata")["full"])

    def test_gmail_read_multipart(self):
        enc = lambda s: base64.urlsafe_b64encode(s.encode()).decode().rstrip("=")
        self.http.on("GET", "/messages/m2?format=full", body={"payload": {"headers": [{"name": "Subject", "value": "S"}], "parts": [
            {"mimeType": "text/html", "body": {"data": enc("<p>html</p>")}},
            {"mimeType": "text/plain", "body": {"data": enc("plain body ✓")}}]}})
        out = C.gmail_read("m2")
        self.assertIn("Subject: S", out)
        self.assertIn("plain body ✓", out)
        self.assertNotIn("html", out)

    def test_gmail_read_rejects_bad_id(self):
        with self.assertRaises(C.ConnectorError):
            C.gmail_read("../../etc")

    def test_gmail_send_preview_then_send(self):
        p = C.call("gmail_send", {"to": "Bob <bob@example.com>", "subject": "Hi", "body": "Line1", "evil": "x"}, dry_run=True)
        self.assertIn("From: me@gmail.com", p["preview"])
        self.assertIn("To: bob@example.com", p["preview"])
        self.assertFalse(any("send" in c["url"] for c in self.http.calls))  # dry run sends nothing
        self.http.on("POST", "/messages/send", body={"id": "sent1"})
        r = C.call("gmail_send", {"to": "bob@example.com", "subject": "Hi", "body": "Line1"}, dry_run=False)
        self.assertIn("sent1", r["result"])
        raw = base64.urlsafe_b64decode(self.http.last("/messages/send")["body"]["raw"]).decode()
        self.assertIn("To: bob@example.com", raw)
        self.assertIn("Subject: Hi", raw)

    def test_gmail_send_bad_address(self):
        with self.assertRaises(C.ConnectorError):
            C.call("gmail_send", {"to": "not-an-email", "subject": "x", "body": "y"})

    def test_calendar(self):
        self.http.on("GET", "calendar/v3/calendars/primary/events?", body={"items": [
            {"id": "e1", "summary": "Standup", "start": {"dateTime": "2026-11-09T10:00:00+05:30"}, "end": {"dateTime": "2026-11-09T10:15:00+05:30"}, "location": "Zoom"}]})
        out = C.calendar_events("2026-11-09", "2026-11-09")
        self.assertIn("[e1]", out); self.assertIn("Standup @ Zoom", out)
        p = self.http.last("calendars/primary/events?")["params"]
        self.assertTrue(p["timeMin"].startswith("2026-11-09T00:00:00"))
        self.assertTrue(p["timeMax"].startswith("2026-11-10T00:00:00"))  # bare end date = through that day

    def test_calendar_create(self):
        prev = C.call("calendar_create", {"title": "Dentist", "start": "2026-11-12 16:00"})["preview"]
        self.assertIn("Title: Dentist", prev); self.assertIn("16:00 – Thu 12 Nov 2026 17:00", prev)
        self.http.on("POST", "calendars/primary/events", body={"htmlLink": "https://cal/x"})
        r = C.call("calendar_create", {"title": "Dentist", "start": "2026-11-12 16:00", "attendees": "a@b.co"}, dry_run=False)
        req = self.http.last("calendars/primary/events?sendUpdates")
        self.assertEqual(req["params"]["sendUpdates"], "all")
        self.assertEqual(req["body"]["start"]["timeZone"], C._local_tz())
        self.assertIn("https://cal/x", r["result"])

    def test_calendar_end_before_start(self):
        with self.assertRaises(C.ConnectorError):
            C.call("calendar_create", {"title": "x", "start": "2026-11-12 16:00", "end": "2026-11-12 15:00"})

    def test_drive(self):
        self.http.on("GET", "drive/v3/files?q=", body={"files": [{"id": "f1", "name": "Budget", "mimeType": "application/vnd.google-apps.spreadsheet", "modifiedTime": "2026-11-01T00:00:00Z"}]})
        out = C.drive_search("o'brien budget")
        self.assertIn("[f1] Budget (spreadsheet", out)
        self.assertIn("name contains 'o\\'brien budget'", self.http.last("drive/v3/files?q=")["params"]["q"])
        self.http.on("GET", "drive/v3/files/f1?fields", body={"name": "Budget", "mimeType": "application/vnd.google-apps.spreadsheet"})
        self.http.on("GET", "drive/v3/files/f1/export", raw=b"a,b\n1,2\n")
        out = C.drive_read("f1")
        self.assertIn("a,b\n1,2", out)
        self.assertEqual(self.http.last("/export")["params"]["mimeType"], "text/csv")


class MicrosoftTools(Base):
    def setUp(self):
        super().setUp()
        connect("microsoft", self.http, [("GET", "graph.microsoft.com/v1.0/me?", {"mail": "me@outlook.com"})])

    def test_search_and_read(self):
        self.http.on("GET", "/me/messages?", body={"value": [{"id": "AAMk=", "subject": "Invoice", "from": {"emailAddress": {"name": "Acme", "address": "bill@acme.com"}}, "receivedDateTime": "2026-11-05T09:00:00Z", "bodyPreview": "Due"}]})
        out = C.outlook_search('invoice "acme"')
        self.assertIn("[AAMk=] 2026-11-05 09:00 | From: Acme <bill@acme.com> | Subject: Invoice", out)
        self.assertEqual(self.http.last("/me/messages?")["params"]["$search"], '"invoice acme"')
        self.http.on("GET", "/me/messages/AAMk%3D", body={"subject": "Invoice", "from": {"emailAddress": {"address": "bill@acme.com"}}, "toRecipients": [], "body": {"content": "Pay by Friday"}})
        out = C.outlook_read("AAMk=")
        self.assertIn("Pay by Friday", out)
        self.assertEqual(self.http.last("/me/messages/AAMk")["headers"]["Prefer"], 'outlook.body-content-type="text"')

    def test_send(self):
        self.http.on("POST", "/me/sendMail", raw=b"")
        r = C.call("outlook_send", {"to": "x@y.com, z@w.org", "subject": "S", "body": "B"}, dry_run=False)
        b = self.http.last("/me/sendMail")["body"]
        self.assertEqual([t["emailAddress"]["address"] for t in b["message"]["toRecipients"]], ["x@y.com", "z@w.org"])
        self.assertTrue(b["saveToSentItems"])
        self.assertIn("Sent", r["result"])

    def test_onedrive_read_does_not_send_token_to_download_host(self):
        self.http.on("GET", "/me/drive/items/F1", body={"name": "notes.txt", "size": 5, "@microsoft.graph.downloadUrl": "https://dl.example/abc"})
        self.http.on("GET", "https://dl.example/abc", raw=b"hello")
        out = C.onedrive_read("F1")
        self.assertIn("hello", out)
        self.assertNotIn("Authorization", self.http.last("dl.example")["headers"])

    def test_calendar_create_body(self):
        self.http.on("POST", "/me/events", body={"webLink": "https://outlook/x"})
        C.call("outlook_calendar_create", {"title": "Review", "start": "2026-11-12 09:30", "end": "2026-11-12 10:00"}, dry_run=False)
        b = self.http.last("/me/events")["body"]
        self.assertEqual(b["start"], {"dateTime": "2026-11-12T09:30:00", "timeZone": C._local_tz()})
        self.assertEqual(b["end"]["dateTime"], "2026-11-12T10:00:00")


class XTools(Base):
    def setUp(self):
        super().setUp()
        connect("x", self.http, [("GET", "api.x.com/2/users/me", {"data": {"id": "42", "username": "pankaj"}})])

    def test_post_preview_and_limit(self):
        self.assertIn("as @pankaj", C.call("x_post", {"text": "hello"})["preview"])
        with self.assertRaises(C.ConnectorError):
            C.call("x_post", {"text": "x" * 281})
        self.http.on("POST", "api.x.com/2/tweets", body={"data": {"id": "999"}})
        self.assertEqual(C.call("x_post", {"text": "hello"}, dry_run=False)["result"], "Posted: https://x.com/pankaj/status/999")

    def test_search_paid_plan_message(self):
        self.http.on("GET", "tweets/search/recent", status=403, body={"detail": "client-not-enrolled"})
        with self.assertRaises(C.ConnectorError) as cm:
            C.x_search("qwen")
        self.assertIn("paid X API plan", str(cm.exception))


class Registry(Base):
    def test_schemas_only_for_connected(self):
        self.assertEqual(C.tool_schemas(), [])
        connect("x", self.http, [("GET", "api.x.com/2/users/me", {"data": {"id": "1", "username": "u"}})])
        names = [t["function"]["name"] for t in C.tool_schemas()]
        self.assertEqual(sorted(names), ["x_my_posts", "x_post", "x_search"])
        self.assertIn("gmail_send", C.write_tools())

    def test_call_validation(self):
        with self.assertRaises(C.ConnectorError):
            C.call("rm_rf", {})
        with self.assertRaises(C.ConnectorError):
            C.call("gmail_read", {})


if __name__ == "__main__":
    unittest.main()
