"""End to end over MCP against mock servers: what the calendar extension sends where.

    python e2e_calendar_mcp.py [apps/server dir]
"""
import base64
import http.server
import json
import os
import socket
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path
from xml.sax.saxutils import escape

APP = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
socketserver.BaseServer.handle_error = lambda *a: None
MS = ('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
      '{}</d:multistatus>')


def resp(href, props):
    return (f"<d:response><d:href>{href}</d:href><d:propstat><d:prop>{props}</d:prop>"
            "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>")


class Log(list):
    pass


def make_handler(log, nextcloud=False, refuses=False):
    """DSM-like by default: the DAV root /caldav/ answers OPTIONS. With
    nextcloud=True /caldav/ does not exist and only /.well-known/caldav leads
    to the endpoint."""
    root, principal = ("/remote.php/dav/", "/remote.php/dav/p/u/") if nextcloud else ("/caldav/", "/caldav.php/u/")

    class H(http.server.BaseHTTPRequestHandler):
        def _send(self, code, body=b"", headers=()):
            self.send_response(code)
            given = {k.lower() for k, _ in headers}
            if "content-type" not in given:
                self.send_header("Content-Type", "application/xml")
            self.send_header("Content-Length", str(len(body)))
            for k, v in headers:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _any(self):
            n = int(self.headers.get("Content-Length") or 0)
            self.body = self.rfile.read(n)
            log.append((self.command, self.path, self.headers.get("Authorization"),
                        self.headers.get("If-Match")))
            p, c = self.path, self.command
            if refuses:  # a NAS that refuses the login, like DSM with a wrong password
                return self._send(401, b"Please log in for access to this system.",
                                  [("WWW-Authenticate", 'Basic realm="Synology Calendar"'),
                                   ("Content-Type", "text/plain")])
            if nextcloud and c == "GET" and p == "/.well-known/caldav":
                return self._send(301, headers=[("Location", root)])
            if c == "OPTIONS" and p == root:
                return self._send(200, headers=[("DAV", "1, 2, calendar-access"), ("Allow", "OPTIONS, PROPFIND")])
            if c == "PROPFIND" and p == root:
                body = resp(p, f"<d:current-user-principal><d:href>{principal}</d:href></d:current-user-principal>")
            elif c == "PROPFIND" and p == principal:
                body = resp(p, f"<c:calendar-home-set><d:href>{principal}</d:href></c:calendar-home-set>"
                               "<d:displayname>u</d:displayname>")
            elif c == "REPORT":
                if STATE.get("session_over"):  # DSM login page, HTTP 200
                    return self._send(200, b"<html>login</html>",
                                      [("Content-Type", "text/html")])
                tag = "0" if STATE.get("etag_zero") else '"{}"'
                body = "" if STATE.get("empty") else "".join(
                    resp(h, f"<d:getetag>{tag.format(h)}</d:getetag>"
                            f"<c:calendar-data>{escape(v)}</c:calendar-data>")
                    for h, v in STORE.items() if h.startswith(p))
                if STATE.get("odd_status"):
                    # a block the server marked as failed, with "200" in its text
                    body += ('<d:response><d:href>/caldav.php/u/home/kaputt.ics</d:href>'
                             "<d:propstat><d:prop><c:calendar-data>"
                             + escape(event_ics("nicht-da", "Sollte fehlen"))
                             + "</c:calendar-data></d:prop>"
                             "<d:status>HTTP/1.1 500 Error at line 204</d:status>"
                             "</d:propstat></d:response>")
                if STATE.get("not_found"):  # a 404 block beside the data
                    body += ('<d:response><d:href>/caldav.php/u/home/gone.ics</d:href>'
                             "<d:propstat><d:prop><c:calendar-data/></d:prop>"
                             "<d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>")
            elif c == "PUT":
                if STATE.get("redirect_put"):
                    return self._send(302, b"", [("Location", f"http://127.0.0.1:{EVIL}/cal/x.ics")])
                if STATE.get("json_put"):
                    return self._send(200, b'{"success":false,"error":{"code":119}}',
                                      [("Content-Type", "application/json")])
                STORE[p] = self.body.decode()
                return self._send(204)
            elif c == "PROPFIND" and p.endswith(".ics"):
                body = resp(p, '<d:getetag>"e1"</d:getetag>')
            elif c == "DELETE":
                if STATE.get("html_delete"):  # DSM after the session ended
                    return self._send(200, b"<html>login</html>", [("Content-Type", "text/html")])
                if STATE.get("json_delete"):  # DSM's own web API answers errors like this
                    return self._send(200, b'{"success":false,"error":{"code":119}}',
                                      [("Content-Type", "application/json")])
                if STATE.get("bare_delete"):  # 200 and nothing else - DSM confirms with 204
                    return self._send(200)
                STORE.pop(p, None)
                return self._send(204)
            else:
                return self._send(404)
            self._send(207, MS.format(body).encode())

        do_GET = do_PROPFIND = do_OPTIONS = do_REPORT = do_PUT = do_DELETE = _any

        def log_message(self, *a):
            pass
    return H


def serve(log, nextcloud=False, refuses=False):
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), make_handler(log, nextcloud, refuses))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd.server_address[1]


def silent_server():
    """Accepts connections and never answers."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(50)
    held = []
    threading.Thread(target=lambda: [held.append(s.accept()) for _ in iter(int, 1)], daemon=True).start()
    return s.getsockname()[1]


ICS_OK = ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ok-1\r\n"
          "SUMMARY:Urlaub\r\nDTSTART;VALUE=DATE:20260922\r\nDTEND;VALUE=DATE:20260923\r\n"
          "DTSTAMP:20260901T080000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
ICS_BROKEN = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY ohne Doppelpunkt\r\n"
# a task the calendar app stored under a name of its own, with a date-only due
ICS_TODO = ("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:todo-eigen\r\n"
            "SUMMARY:Müll rausbringen\r\nDUE;VALUE=DATE:20260925\r\nSTATUS:in-process\r\n"
            "DTSTAMP:20260901T080000Z\r\nEND:VTODO\r\nEND:VCALENDAR\r\n")
def event_ics(uid, summary="Termin"):
    return (f"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nSUMMARY:{summary}\r\n"
            "DTSTART:20260924T080000Z\r\nDTEND:20260924T090000Z\r\n"
            "DTSTAMP:20260901T080000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")


STORE = {
    "/caldav.php/u/home/ok-1.ics": ICS_OK,
    "/caldav.php/u/home/broken.ics": ICS_BROKEN,
    "/caldav.php/u/home/2026-09-25-muell.ics": ICS_TODO,
    "/caldav.php/u/home/abc-123@example.com.ics": event_ics("abc-123@example.com"),
    "/caldav.php/u/home/abs-1.ics": event_ics("abs-1"),
    "/remote.php/dav/p/u/home/n1.ics": event_ics("n1"),
    # a uid the calendar app would never put into a file name
    "/caldav.php/u/home/seltsam.ics": event_ics("a%b", "Seltsame Kennung"),
    "/caldav.php/u/home/abs-2.ics": event_ics("abs-2"),
}
STATE = {}
nas_log, evil_log, nc_log = Log(), Log(), Log()
NAS, EVIL, SILENT, NC = serve(nas_log), serve(evil_log), silent_server(), serve(nc_log, nextcloud=True)
PASSWORD = os.environ.get("E2E_PASSWORD", "pä€ss")


class Mcp:
    def __init__(self, host, timeout="10"):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("CALDAV_", "NODE_"))}
        env.update(CALDAV_HOST=host, CALDAV_HTTPS="false", CALDAV_USERNAME="u",
                   CALDAV_PASSWORD=PASSWORD, CALDAV_TIMEOUT=timeout, TZ="Europe/Berlin")
        self.p = subprocess.Popen(["node", str(APP / "index.js")], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
                                  text=True, encoding="utf-8")
        self.n = 0
        self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                "clientInfo": {"name": "t", "version": "1"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")

    def rpc(self, method, params):
        self.n += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())

    def call(self, tool, **args):
        r = self.rpc("tools/call", {"name": tool, "arguments": args})
        r = r.get("result") or {"isError": True, "content": [{"text": json.dumps(r.get("error"))}]}
        return r.get("isError", False), "\n".join(x.get("text", "") for x in r["content"])

    def close(self):
        self.p.stdin.close()
        try:
            self.p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.p.kill()


failures = 0


def check(label, cond, detail=""):
    global failures
    print(("ok   " if cond else "FAIL ") + label + ("" if cond else f"\n       -> {detail}"))
    failures += not cond


m = Mcp(f"127.0.0.1:{NAS}")

# --- the password never leaves the NAS
for url in (f"http://127.0.0.1:{EVIL}/cal/", f"//127.0.0.1:{EVIL}/cal/", f"/\\127.0.0.1:{EVIL}/cal/",
            f"http://u:x@127.0.0.1:{EVIL}/cal/"):
    err, text = m.call("delete-event", uid="abc", calendarUrl=url)
    check(f"foreign calendarUrl {url!r} refused", err and "Refused" in text, text)
    err, text = m.call("list-events", calendarUrl=url, start="2026-09-01T00:00:00Z", end="2026-09-30T00:00:00Z")
    check("... also for list-events", err and "Refused" in text, text)
check("... the foreign host saw no request at all", not evil_log, evil_log)

# --- uid path injection
nas_log.clear()
for uid in ("../work/victim", "#", "?x", "a%2Fb", "a\\b"):
    err, text = m.call("delete-event", uid=uid, calendarUrl="/caldav.php/u/home/")
    # not refused outright - an object may carry such a uid - but it never
    # becomes part of an address, so it is looked up and not found
    check(f"uid {uid!r} never becomes an address", err and "not found" in text.lower(), text)
for url in ("/caldav.php/u/home/?", "/caldav.php/u/home/#", "/caldav.php/u/home/?x=1"):
    err, text = m.call("delete-event", uid="abc", calendarUrl=url)
    check(f"calendarUrl {url!r} refused", err and "Refused" in text, text)
check("... no DELETE reached the NAS", not [x for x in nas_log if x[0] == "DELETE"], nas_log)
check("... and no request carried such a uid in its path",
      not [x for x in nas_log if "victim" in x[1] or "%2F" in x[1] or x[1].endswith("/#.ics")],
      nas_log[-3:])
err, text = m.call("delete-event", uid="a%b", calendarUrl="/caldav.php/u/home/")
check("an object that really carries such a uid is found and deleted",
      not err and "deleted" in text.lower(), text)
check("... at the name the calendar app gave it",
      "/caldav.php/u/home/seltsam.ics" not in STORE
      and [x for x in nas_log if x[0] == "DELETE"][-1][1] == "/caldav.php/u/home/seltsam.ics",
      nas_log[-3:])

# --- the normal path still works, discovery skips its probes, UTF-8 credentials
nas_log.clear()
err, text = m.call("delete-event", uid="abc-123@example.com", calendarUrl="/caldav.php/u/home/")
check("valid delete works", not err and "deleted" in text, text)
dels = [x[1] for x in nas_log if x[0] == "DELETE"]
check("... on exactly that object", dels == ["/caldav.php/u/home/abc-123@example.com.ics"], nas_log)
m.close()  # a fresh session, so the first requests are the ones being looked at
m = Mcp(f"127.0.0.1:{NAS}")
nas_log.clear()
err, text = m.call("delete-event", uid="abs-2", calendarUrl="/caldav.php/u/home/")
check("valid delete works in a fresh session", not err, text)
first_propfind = next(i for i, x in enumerate(nas_log) if x[0] == "PROPFIND")
check("... no discovery probes: only OPTIONS on the DAV root before the first PROPFIND",
      [x[:2] for x in nas_log[:first_propfind + 1]] == [("OPTIONS", "/caldav/"), ("PROPFIND", "/caldav/")],
      nas_log[:4])
auth = nas_log[0][2] or ""
decoded = base64.b64decode(auth.split(" ", 1)[1]).decode("utf-8") if auth.startswith("Basic ") else ""
check("password with € and umlaut sent as UTF-8", decoded == f"u:{PASSWORD}", (auth, decoded))
err, text = m.call("delete-event", uid="abs-1", calendarUrl=f"http://127.0.0.1:{NAS}/caldav.php/u/home/")
check("absolute URL on the NAS accepted", not err, text)

# --- a damaged object does not take the whole calendar with it
err, text = m.call("list-events", calendarUrl="/caldav.php/u/home/",
                   start="2026-09-01T00:00:00Z", end="2026-10-01T00:00:00Z")
listed = json.loads(text.splitlines()[0])
check("damaged object skipped, the rest still listed", not err and len(listed) == 1
      and listed[0]["uid"] == "ok-1" and listed[0]["wholeDay"] is True, (err, text))
check("... and it says which one is missing", "broken.ics" in text and "could not be read" in text, text)
m.close()

# --- what is created must be findable again
m = Mcp(f"127.0.0.1:{NAS}")
CAL = "/caldav.php/u/home/"
err, uid = m.call("create-event", calendarUrl=CAL, summary="Team",
                  start="2026-11-02T10:00:00+01:00", end="2026-11-02T11:00:00+01:00",
                  recurrenceRule={"freq": "WEEKLY", "until": "2026-11-30T23:00:00Z"})
check("create a series", not err and uid, uid)
err, text = m.call("list-events", calendarUrl=CAL,
                   start="2026-11-01T00:00:00Z", end="2026-12-01T00:00:00Z")
series = [e for e in json.loads(text.splitlines()[0]) if e["uid"] == uid.strip()]
check("the series is listed on each of its dates", len(series) == 5
      and series[0]["start"] == "2026-11-02T09:00:00.000Z" and series[0].get("recurring"), series)
err, uid2 = m.call("create-event", calendarUrl=CAL, summary="Urlaub", wholeDay=True,
                   start="2026-12-03T00:00:00+01:00", end="2026-12-05T00:00:00+01:00")
err, text = m.call("list-events", calendarUrl=CAL,
                   start="2026-12-01T00:00:00Z", end="2026-12-10T00:00:00Z")
whole = [e for e in json.loads(text.splitlines()[0]) if e["uid"] == uid2.strip()]
check("a whole-day event keeps its days", whole and whole[0]["start"] == "2026-12-03"
      and whole[0]["end"] == "2026-12-05" and whole[0].get("wholeDay"), whole)
err, uid3 = m.call("create-todo", calendarUrl=CAL, summary="Steuer",
                   due="2026-11-20T12:00:00+01:00")
err, text = m.call("list-todos", calendarUrl=CAL)
todos = json.loads(text)["todos"]
check("a created task is listed", any(t["uid"] == uid3.strip() for t in todos), todos)

# --- a task the calendar app stored under its own file name
check("task with a lower-case status found", any(t["uid"] == "todo-eigen"
      and t["status"] == "IN-PROCESS" for t in todos), todos)
err, text = m.call("list-todos", calendarUrl=CAL, due_after="2026-09-25T00:00:00Z",
                   due_before="2026-09-25T23:59:59Z")
check("a due date without a time filters as that date",
      any(t["uid"] == "todo-eigen" for t in json.loads(text)["todos"]), text)
err, text = m.call("delete-todo", uid="todo-eigen", calendarUrl=CAL)
check("... and it can be deleted by uid", not err and "deleted" in text.lower(), text)
check("... really gone", "/caldav.php/u/home/2026-09-25-muell.ics" not in STORE, list(STORE))

# --- a write that is answered with a redirect is not a success
STATE["redirect_put"] = True
err, text = m.call("update-event", uid="ok-1", calendarUrl=CAL, summary="Neu")
check("PUT answered with 302 fails loudly", err, text)
check("... and the foreign host saw nothing of it", not evil_log, evil_log)
STATE.clear()

# --- a delete that was not carried out is not a success
STORE["/caldav.php/u/home/bleibt.ics"] = event_ics("bleibt-1")
STATE["html_delete"] = True
err, text = m.call("delete-event", uid="bleibt-1", calendarUrl=CAL)
check("delete answered with a web page fails", err and "session" in text.lower(), text)
check("... and the entry is still there", "/caldav.php/u/home/bleibt.ics" in STORE)
STATE.clear()

# --- and one answered the way DSM's own web API answers: HTTP 200, success:false
KEEP = "/caldav.php/u/home/bleibt2.ics"
STORE[KEEP] = event_ics("bleibt-2")
STATE["json_delete"] = True
err, text = m.call("delete-event", uid="bleibt-2", calendarUrl=CAL)
check("delete answered with a status message fails", err and "session" in text.lower(), text)
check("... and that entry is still there", KEEP in STORE)
STATE.clear()

STATE["json_put"] = True
err, text = m.call("update-event", uid="bleibt-2", calendarUrl=CAL, summary="Neu")
check("a write answered with a status message fails", err and "session" in text.lower(), text)
check("... and the entry keeps its old text", "Neu" not in STORE[KEEP], STORE[KEEP])
STATE.clear()

# --- the NAS confirms a delete with 204; a bare 200 is not a confirmation
STATE["bare_delete"] = True
err, text = m.call("delete-event", uid="bleibt-2", calendarUrl=CAL)
check("delete answered with a bare 200 fails", err and "session" in text.lower(), text)
check("... and that entry is still there too", KEEP in STORE)
STATE.clear()

# --- a repetition that cannot be written is refused before anything is sent
before = dict(STORE)
err, text = m.call("create-event", calendarUrl=CAL, summary="Doppelt",
                   start="2026-11-02T10:00:00Z", end="2026-11-02T11:00:00Z",
                   recurrenceRule={"freq": "WEEKLY", "count": 5, "until": "2026-12-31T23:00:00Z"})
check("count and until together refused", err and "not both" in text, text)
for bad in ({"freq": "DAILY", "count": 0}, {"freq": "DAILY", "count": -3},
            {"freq": "DAILY", "byday": ["MO;FREQ=YEARLY"]}, {"freq": "DAILY", "interval": 0}):
    err, text = m.call("create-event", calendarUrl=CAL, summary="Unsinn",
                       start="2026-11-02T10:00:00Z", end="2026-11-02T11:00:00Z",
                       recurrenceRule=bad)
    check(f"rule {bad} refused", err, text)
check("... and nothing was written", STORE == before, set(STORE) ^ set(before))

# --- an ETag of "0" is a version mark like any other
STATE["etag_zero"] = True
nas_log.clear()
m.call("update-event", uid="bleibt-1", calendarUrl=CAL, summary="Neu")
puts = [x for x in nas_log if x[0] == "PUT"]
check("ETag 0 is used, not replaced by *", puts and puts[-1][3] == "0", puts)
STATE.clear()

# --- a block the server marked as failed is not data
STATE["odd_status"] = True
err, text = m.call("list-events", calendarUrl=CAL, start="2026-09-01T00:00:00Z",
                   end="2026-10-01T00:00:00Z")
check("a 500 block whose text contains '200' is not listed",
      not err and "nicht-da" not in text, text)
STATE.clear()

# --- the cap is for the whole answer
for i in range(3):
    STORE[f"/caldav.php/u/home/serie{i}.ics"] = (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:serie-" + str(i)
        + "\r\nSUMMARY:Taeglich\r\nDTSTART:20260101T0" + str(i) + "0000Z\r\n"
        "DTEND:20260101T0" + str(i) + "3000Z\r\nRRULE:FREQ=DAILY\r\n"
        "DTSTAMP:20260101T000000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
err, text = m.call("list-events", calendarUrl=CAL, start="2026-01-01T00:00:00Z",
                   end="2027-01-01T00:00:00Z")
listed = json.loads(text.splitlines()[0])
check(f"at most 500 appointments in one answer ({len(listed)})", len(listed) == 500, len(listed))
check("... and it says so", "500 appointments is the most" in text, text.splitlines()[-1][:60])
for i in range(3):
    STORE.pop(f"/caldav.php/u/home/serie{i}.ics")

# --- nothing in the period is an empty list, not an error
STATE["empty"] = True
err, text = m.call("list-events", calendarUrl=CAL, start="2027-01-01T00:00:00Z",
                   end="2027-01-08T00:00:00Z")
check("a period without appointments answers with an empty list",
      not err and json.loads(text.splitlines()[0]) == [], text)
err, text = m.call("list-todos", calendarUrl=CAL)
check("... and a calendar without tasks too", not err and json.loads(text)["total"] == 0, text)
STATE.clear()

# --- an ended session is not an empty calendar
STATE["session_over"] = True
err, text = m.call("list-events", calendarUrl=CAL, start="2026-11-01T00:00:00Z",
                   end="2026-12-01T00:00:00Z")
check("session gone: says so instead of 'empty'", err and "session" in text.lower(), text)
STATE.clear()
STATE["not_found"] = True
err, text = m.call("list-events", calendarUrl=CAL, start="2026-09-01T00:00:00Z",
                   end="2026-10-01T00:00:00Z")
check("a 404 block in the answer is not data", not err and "gone.ics" not in text, text)
STATE.clear()
m.close()

# --- another server, found only through /.well-known/caldav, still connects
m = Mcp(f"127.0.0.1:{NC}")
err, text = m.call("delete-event", uid="n1", calendarUrl="/remote.php/dav/p/u/home/")
check("server behind a /.well-known redirect still works", not err and "deleted" in text, (text, nc_log[:8]))
m.close()

# --- a broken NAS address gets a readable error on every tool
m = Mcp("fe80::1")
for tool, args in (("list-events", {"calendarUrl": "/cal/", "start": "2026-09-01T00:00:00Z",
                                    "end": "2026-09-30T00:00:00Z"}), ("list-calendars", {})):
    err, text = m.call(tool, **args)
    check(f"broken address: {tool} explains it", err and ("not valid" in text or "Invalid URL" in text), text)
m.close()

# --- a refused login costs exactly one refused login
refused_log = Log()
REFUSED = serve(refused_log, refuses=True)
m = Mcp(f"127.0.0.1:{REFUSED}")
err, text = m.call("list-calendars")
check("a refused login is reported as such", err and "did not accept the login" in text, text)
check(f"... after exactly one attempt ({len(refused_log)})", len(refused_log) == 1, refused_log)
err, text = m.call("list-events", calendarUrl="/caldav.php/u/home/",
                   start="2026-09-01T00:00:00Z", end="2026-10-01T00:00:00Z")
check(f"... and one more per further call ({len(refused_log)})", len(refused_log) == 2, refused_log)
m.close()

# --- a NAS that never answers costs one timeout, not eight
m = Mcp(f"127.0.0.1:{SILENT}", timeout="5")  # 5 s is the smallest the dialog offers
t0 = time.time()
err, text = m.call("list-calendars")
took = time.time() - t0
check(f"silent NAS fails after one timeout ({took:.1f} s)", err and took < 12, (took, text))
m.close()

print("\nFAILED" if failures else "\nall passed", failures)
sys.exit(1 if failures else 0)

