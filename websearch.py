"""Web search (DuckDuckGo's HTML page, no account needed) and readable-text extraction from web pages.

Used only when the app's Search toggle is on. Page fetching refuses local/private network addresses,
including after redirects, so a search result can't make this server reach devices on your network.
"""
import gzip
import html
import ipaddress
import os
import re
import json
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from html.parser import HTMLParser

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
MAX_PAGE_BYTES = 2_000_000
MAX_TEXT_CHARS = 8000


def _ssl_context():
    # python.org builds on macOS ship without CA certificates; fall back to the system bundle
    ctx = ssl.create_default_context()
    if not ctx.get_ca_certs() and os.path.exists("/etc/ssl/cert.pem"):
        ctx = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
    return ctx


SSL_CTX = _ssl_context()


class BlockedURL(Exception):
    pass


def check_public_url(url):
    """Raise BlockedURL unless url is http(s) and its host resolves only to public addresses."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise BlockedURL("only http(s) URLs can be fetched")
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
    except socket.gaierror:
        raise BlockedURL(f"can't resolve {parts.hostname}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global:
            raise BlockedURL(f"{parts.hostname} is a local or private address")


class _SafeRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_SafeRedirects, urllib.request.HTTPSHandler(context=SSL_CTX))


def _get(url, timeout=10):
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.8", "Accept-Encoding": "gzip, deflate",
    })
    return _opener.open(req, timeout=timeout)


def _read_body(r):
    # Some sites compress even when not asked, so always check
    data = r.read(MAX_PAGE_BYTES)
    enc = (r.headers.get("Content-Encoding") or "").lower()
    if "gzip" in enc or data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    elif "deflate" in enc:
        data = zlib.decompress(data, -zlib.MAX_WBITS if data[:1] != b"\x78" else zlib.MAX_WBITS)
    return data


# ---------- Search ----------

class _DDGParser(HTMLParser):
    """Pulls title / url / snippet out of html.duckduckgo.com results, skipping ads."""

    def __init__(self):
        super().__init__()
        self.results, self._cur, self._field, self._in_ad = [], None, None, False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class", "")
        if tag == "div" and "result" in cls.split() and "results_links" in cls:
            self._in_ad = "result--ad" in cls
            self._cur = None if self._in_ad else {"title": "", "url": "", "snippet": ""}
            if self._cur is not None:
                self.results.append(self._cur)
        elif self._cur is not None and tag == "a" and "result__a" in cls:
            self._cur["url"] = _unwrap_ddg(a.get("href", ""))
            self._field = "title"
        elif self._cur is not None and "result__snippet" in cls:
            self._field = "snippet"

    def handle_endtag(self, tag):
        if tag in ("a", "td", "div"):
            self._field = None

    def handle_data(self, data):
        if self._cur is not None and self._field:
            self._cur[self._field] += data


def _unwrap_ddg(href):
    # Result links go through //duckduckgo.com/l/?uddg=<real url>
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(href).query)
    return q.get("uddg", [href])[0]


# Searches are paced (DuckDuckGo rate-limits bursts), cached for a few minutes, and fall back to
# Wikipedia's search API if DuckDuckGo refuses or fails.
_MIN_GAP = 1.2  # seconds between DuckDuckGo requests
_CACHE_TTL = 600
_cache = {}  # query -> (time, results)
_ddg_lock = threading.Lock()
_ddg_last = 0.0
_ddg_blocked_until = 0.0


def search(query, max_results=6):
    key = " ".join(query.lower().split())
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < _CACHE_TTL:
        return hit[1][:max_results]
    results, ddg_error = [], None
    if time.time() >= _ddg_blocked_until:
        try:
            results = _search_ddg(query, max_results)
        except Exception as e:
            ddg_error = e
    if not results:
        try:
            results = _search_wikipedia(query, max_results)
        except Exception:
            if ddg_error:
                raise ddg_error
            raise
    if results:
        _cache[key] = (time.time(), results)
        if len(_cache) > 300:
            for k in sorted(_cache, key=lambda k: _cache[k][0])[:100]:
                del _cache[k]
    return results


def _search_wikipedia(query, max_results):
    url = "https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode({
        "action": "query", "list": "search", "srsearch": query, "srlimit": max_results, "format": "json",
    })
    with _get(url) as r:
        data = json.loads(_read_body(r).decode("utf-8", "replace"))
    out = []
    for item in data.get("query", {}).get("search", []):
        title = item.get("title", "")
        snippet = html.unescape(re.sub(r"<[^>]+>", "", item.get("snippet", "")))
        out.append({
            "title": f"{title} - Wikipedia",
            "url": "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
            "snippet": " ".join(snippet.split()),
        })
    return out


def _search_ddg(query, max_results):
    global _ddg_last, _ddg_blocked_until
    with _ddg_lock:  # one request at a time, spaced out
        wait = _ddg_last + _MIN_GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        _ddg_last = time.time()
    url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
    with _get(url) as r:
        page = _read_body(r).decode("utf-8", "replace")
    p = _DDGParser()
    p.feed(page)
    out, seen = [], set()
    for res in p.results:
        link = res["url"]
        if not link.startswith("http") or link in seen or "duckduckgo.com/y.js" in link:
            continue
        seen.add(link)
        out.append({
            "title": " ".join(res["title"].split()),
            "url": link,
            "snippet": " ".join(res["snippet"].split()),
        })
        if len(out) >= max_results:
            break
    if not out and "anomaly" in page.lower():
        _ddg_blocked_until = time.time() + 60  # use Wikipedia for a minute
        raise RuntimeError("DuckDuckGo is rate-limiting searches right now — try again in a minute")
    return out


# ---------- Reading pages ----------

class _TextExtractor(HTMLParser):
    """Keeps the readable text of a page: paragraphs, headings, list items, table cells."""
    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form", "iframe", "button", "select"}
    BLOCK = {"p", "div", "section", "article", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "br", "pre", "blockquote", "dd", "dt"}

    def __init__(self):
        super().__init__()
        self.parts, self.title, self._skip, self._in_title = [], "", 0, False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)


def fetch_text(url):
    check_public_url(url)
    with _get(url, timeout=8) as r:
        ctype = r.headers.get("Content-Type", "")
        if not any(t in ctype for t in ("text/html", "text/plain", "application/xhtml")):
            raise RuntimeError(f"not a web page ({ctype.split(';')[0] or 'unknown type'})")
        charset = r.headers.get_content_charset() or "utf-8"
        raw = _read_body(r).decode(charset, "replace")
        final_url = r.geturl()
    if "text/plain" in ctype:
        title, text = "", raw
    else:
        p = _TextExtractor()
        p.feed(raw)
        title, text = html.unescape(" ".join(p.title.split())), "".join(p.parts)
    # Tidy whitespace and drop very short lines (menus, buttons, cookie banners)
    lines = [" ".join(line.split()) for line in text.splitlines()]
    lines = [line for line in lines if len(line) > 30 or (line and line[-1:] in ".:?!")]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return {"url": final_url, "title": title, "text": text[:MAX_TEXT_CHARS], "truncated": len(text) > MAX_TEXT_CHARS}
