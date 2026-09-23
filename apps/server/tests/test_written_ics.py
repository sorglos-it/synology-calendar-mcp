"""What the calendar extension writes into the iCalendar it sends back.

    python test_calendar_ical.py [apps/server dir]

Same shape as e2e_calendar_mcp.py: starts `node <apps/server>/index.js` against a
mock CalDAV server on 127.0.0.1, speaks MCP over stdio and looks at the requests
that arrive. Where that suite watches *where* requests go, this one watches
*what* is in them - the round trip of an existing ICS through update-event,
complete-todo and friends, and the shape of what list-events returns.

The mock is a deliberately plain CalDAV server: it answers a calendar-query with
every object of the asked component and does no time-range filtering and no
recurrence expansion - exactly like DSM, which hands out the stored ICS and
leaves expansion to the client.

Nothing here talks to a real host. Every check is one "ok "/"FAIL " line.
"""
import base64
import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

APP = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
socketserver.BaseServer.handle_error = lambda *a: None

DAV_ROOT = "/caldav/"
PRINCIPAL = "/caldav.php/u/"
CAL = "/caldav.php/u/home/"

MS = ('<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" '
      'xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">'
      '{}</d:multistatus>')


def resp(href, props):
    return (f"<d:response><d:href>{href}</d:href><d:propstat><d:prop>{props}</d:prop>"
            "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>")


def ics(text):
    """CRLF line endings, as a CalDAV server stores and serves them."""
    return text.strip("\n").replace("\r\n", "\n").replace("\n", "\r\n") + "\r\n"


# --- the calendar the mock serves -------------------------------------------

SERIES = ics("""
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Sorglos//Testkalender//DE
CALSCALE:GREGORIAN
BEGIN:VTIMEZONE
TZID:Europe/Berlin
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:series-1
DTSTAMP:20260901T120000Z
CREATED:20260901T120000Z
LAST-MODIFIED:20260901T120000Z
SEQUENCE:2
SUMMARY:Teambesprechung
DESCRIPTION:Jede Woche im Besprechungsraum
LOCATION:Buero
DTSTART;TZID=Europe/Berlin:20260907T100000
DTEND;TZID=Europe/Berlin:20260907T110000
RRULE:FREQ=WEEKLY;COUNT=10
EXDATE;TZID=Europe/Berlin:20260921T100000
ORGANIZER;CN=Thomas:mailto:thomas@example.org
ATTENDEE;CN=Anna;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:anna@example.org
END:VEVENT
BEGIN:VEVENT
UID:series-1
RECURRENCE-ID;TZID=Europe/Berlin:20260928T100000
DTSTAMP:20260901T120000Z
SEQUENCE:3
SUMMARY:Teambesprechung verschoben
DTSTART;TZID=Europe/Berlin:20260928T140000
DTEND;TZID=Europe/Berlin:20260928T150000
ORGANIZER;CN=Thomas:mailto:thomas@example.org
ATTENDEE;CN=Anna;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:anna@example.org
END:VEVENT
END:VCALENDAR
""")

ALLDAY = ics("""
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Sorglos//Testkalender//DE
BEGIN:VEVENT
UID:allday-1
DTSTAMP:20260901T120000Z
SEQUENCE:0
SUMMARY:Betriebsausflug
DTSTART;VALUE=DATE:20260922
DTEND;VALUE=DATE:20260923
END:VEVENT
END:VCALENDAR
""")

PLAIN = ics("""
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Sorglos//Testkalender//DE
BEGIN:VEVENT
UID:plain-1
DTSTAMP:20260901T120000Z
SEQUENCE:0
SUMMARY:Zahnarzt
DTSTART:20260924T090000Z
DTEND:20260924T100000Z
END:VEVENT
END:VCALENDAR
""")

TODO = ics("""
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Sorglos//Testkalender//DE
BEGIN:VTODO
UID:todo-1
DTSTAMP:20260901T120000Z
SEQUENCE:1
SUMMARY:Rasen maehen
DESCRIPTION:Erst den Rasen maehen und die Kanten schneiden\\, dann die Hecke
 stutzen und zum Schluss die Blumen giessen.
DUE;VALUE=DATE:20260925
RRULE:FREQ=WEEKLY
CATEGORIES:Haus,Garten
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR
""")

# The object file names, plus the "<uid>.ics" name the client addresses them by.
OBJECTS = {"series.ics": SERIES, "allday.ics": ALLDAY, "plain.ics": PLAIN, "todo.ics": TODO}
OBJECTS.update({"series-1.ics": SERIES, "allday-1.ics": ALLDAY,
                "plain-1.ics": PLAIN, "todo-1.ics": TODO})
EVENT_OBJECTS = ["series-1.ics", "allday-1.ics", "plain-1.ics"]
TODO_OBJECTS = ["todo-1.ics"]


def xml_escape(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# --- the mock NAS ------------------------------------------------------------

class State:
    def __init__(self):
        self.log = []       # (method, path)
        self.puts = []      # (path, headers dict, body str)
        self.deletes = []   # (path, headers dict)

    def clear(self):
        self.log.clear()
        self.puts.clear()
        self.deletes.clear()


def make_handler(state, deaf=False):
    """deaf=True: a second host that must never be spoken to."""

    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, code, body=b"", headers=()):
            self.send_response(code)
            self.send_header("Content-Type", "application/xml; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            for k, v in headers:
                self.send_header(k, v)
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _object(self):
            return OBJECTS.get(self.path.rsplit("/", 1)[-1])

        def _report(self, body):
            wanted = []
            if "calendar-multiget" in body:
                for href in re.findall(r"<d:href>(.*?)</d:href>", body):
                    name = href.rsplit("/", 1)[-1]
                    if name in OBJECTS:
                        wanted.append(name)
            elif 'name="VTODO"' in body:
                wanted = list(TODO_OBJECTS)
            elif 'name="VEVENT"' in body:
                wanted = list(EVENT_OBJECTS)
            parts = []
            for name in wanted:
                parts.append(resp(CAL + name,
                                  '<d:getetag>"e-' + name + '"</d:getetag>'
                                  "<c:calendar-data>" + xml_escape(OBJECTS[name]) + "</c:calendar-data>"))
            return MS.format("".join(parts)).encode("utf-8")

        def _any(self):
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n).decode("utf-8", "replace")
            state.log.append((self.command, self.path))
            if deaf:
                return self._send(500)
            p, c = self.path, self.command
            if c == "OPTIONS" and p == DAV_ROOT:
                return self._send(200, headers=[("DAV", "1, 2, calendar-access"),
                                                ("Allow", "OPTIONS, PROPFIND, REPORT")])
            if c == "PUT":
                state.puts.append((p, dict(self.headers.items()), raw))
                return self._send(204, headers=[("ETag", '"e-new"')])
            if c == "DELETE":
                state.deletes.append((p, dict(self.headers.items())))
                return self._send(204)
            if c == "GET":
                obj = self._object()
                if obj is None:
                    return self._send(404)
                body = obj.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/calendar; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("ETag", '"e-' + p.rsplit("/", 1)[-1] + '"')
                self.end_headers()
                return self.wfile.write(body)
            if c == "REPORT" and p.rstrip("/") == CAL.rstrip("/"):
                return self._send(207, self._report(raw))
            if c == "PROPFIND" and p == DAV_ROOT:
                body = resp(p, f"<d:current-user-principal><d:href>{PRINCIPAL}</d:href>"
                               "</d:current-user-principal>")
            elif c == "PROPFIND" and p == PRINCIPAL:
                body = resp(p, f"<c:calendar-home-set><d:href>{PRINCIPAL}</d:href></c:calendar-home-set>"
                               "<d:displayname>u</d:displayname>")
            elif c == "PROPFIND" and p.endswith(".ics"):
                if self._object() is None:
                    return self._send(404)
                body = resp(p, '<d:getetag>"e-' + p.rsplit("/", 1)[-1] + '"</d:getetag>')
            elif c == "PROPFIND" and p.rstrip("/") == CAL.rstrip("/"):
                body = resp(p, '<d:displayname>home</d:displayname><cs:getctag>"c1"</cs:getctag>'
                               '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'
                               '<c:supported-calendar-component-set><c:comp name="VEVENT"/>'
                               '<c:comp name="VTODO"/></c:supported-calendar-component-set>')
            else:
                return self._send(404)
            return self._send(207, MS.format(body).encode("utf-8"))

        do_GET = do_PROPFIND = do_OPTIONS = do_REPORT = do_PUT = do_DELETE = _any

        def log_message(self, *a):
            pass

    return H


def serve(state, deaf=False):
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), make_handler(state, deaf))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd.server_address[1]


nas, evil = State(), State()
NAS, EVIL = serve(nas), serve(evil, deaf=True)


# --- MCP over stdio ----------------------------------------------------------

class Mcp:
    def __init__(self, host, timeout="10"):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("CALDAV_", "NODE_"))}
        env.update(CALDAV_HOST=host, CALDAV_HTTPS="false", CALDAV_USERNAME="u",
                   CALDAV_PASSWORD="pw", CALDAV_TIMEOUT=timeout)
        self.p = subprocess.Popen(["node", str(APP / "index.js")], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
                                  text=True, encoding="utf-8")
        self.n = 0
        self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                "clientInfo": {"name": "t", "version": "1"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")

    def rpc(self, method, params):
        self.n += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.n, "method": method,
                                       "params": params}) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line:
            raise SystemExit("the MCP server died - run it by hand to see why")
        return json.loads(line)

    def raw(self, tool, **args):
        r = self.rpc("tools/call", {"name": tool, "arguments": args})
        return r.get("result") or {"isError": True, "content": [{"type": "text",
                                                                 "text": json.dumps(r.get("error"))}]}

    def call(self, tool, **args):
        r = self.raw(tool, **args)
        return r.get("isError", False), "\n".join(x.get("text", "") for x in r["content"])

    def close(self):
        self.p.stdin.close()
        try:
            self.p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.p.kill()


# --- reading an ICS ----------------------------------------------------------

def unfold(text):
    return re.sub(r"\r?\n[ \t]", "", text or "")


def ics_lines(text):
    return [l for l in re.split(r"\r?\n", unfold(text)) if l]


def blocks(text, name):
    """The lines of every BEGIN:<name> ... END:<name> component."""
    out, cur = [], None
    for line in ics_lines(text):
        if line == f"BEGIN:{name}":
            cur = []
        elif line == f"END:{name}":
            if cur is not None:
                out.append(cur)
            cur = None
        elif cur is not None:
            cur.append(line)
    return out


NAME = re.compile(r"^([A-Za-z][A-Za-z0-9-]*)[;:]")


def props(lines, name):
    return [l for l in lines if (NAME.match(l) or [None, ""])[1].upper() == name.upper()]


def value(line):
    return line.split(":", 1)[1] if ":" in line else ""


def one_value(lines, name, default=None):
    found = props(lines, name)
    return value(found[0]) if found else default


def master_and_override(body):
    """The VEVENT without a RECURRENCE-ID, and the ones with."""
    vevents = blocks(body, "VEVENT")
    master = [b for b in vevents if not props(b, "RECURRENCE-ID")]
    override = [b for b in vevents if props(b, "RECURRENCE-ID")]
    return (master[0] if master else []), (override[0] if override else [])


def instant(text):
    """Date.parse() equality: an ISO string as an absolute moment, date-only = UTC midnight."""
    if not isinstance(text, str):
        return None
    try:
        t = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


UTC = timezone.utc


def at(y, mo, d, h=0, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=UTC)


# --- checks ------------------------------------------------------------------

failures = 0
total = 0


def check(label, cond, detail=""):
    global failures, total
    total += 1
    detail = str(detail)
    if len(detail) > 900:
        detail = detail[:900] + " ..."
    print(("ok   " if cond else "FAIL ") + label + ("" if cond else f"\n       -> {detail}"))
    failures += not cond


def put_after(m, tool, **args):
    """One tool call, isolated: returns (isError, text, path, headers, body)."""
    nas.clear()
    err, text = m.call(tool, **args)
    if len(nas.puts) == 1:
        path, headers, body = nas.puts[0]
    else:
        path, headers, body = None, {}, ""
    return err, text, path, headers, body


m = Mcp(f"127.0.0.1:{NAS}")

# =============================================================================
# The two rules that already hold and must not regress
# =============================================================================
print("--- security (holds today)")
nas.clear()
for url in (f"http://127.0.0.1:{EVIL}/cal/", f"//127.0.0.1:{EVIL}/cal/", CAL + "?x=1", CAL + "#a"):
    err, text = m.call("update-event", uid="plain-1", calendarUrl=url, summary="X")
    check(f"update-event refuses calendarUrl {url!r}", err and "Refused" in text, text)
err, text = m.call("list-events", calendarUrl=f"http://127.0.0.1:{EVIL}/cal/",
                   start="2026-09-20T00:00:00Z", end="2026-10-05T00:00:00Z")
check("list-events refuses a foreign calendarUrl", err and "Refused" in text, text)
check("the foreign host saw no request at all", not evil.log, evil.log)
for uid in ("../work/victim", "a%2Fb"):
    # such a uid is not refused - an object may carry it - but it never
    # becomes part of an address; it is looked up and not found here
    err, text = m.call("update-event", uid=uid, calendarUrl=CAL, summary="X")
    check(f"update-event never addresses uid {uid!r}", err and "not found" in text.lower(), text)
    err, text = m.call("complete-todo", uid=uid, calendarUrl=CAL)
    check(f"complete-todo never addresses uid {uid!r}", err and "not found" in text.lower(), text)
check("no request carried such a uid in its path",
      not [r for r in nas.log if "victim" in r[1] or "%2F" in r[1] or "a%b" in r[1]], nas.log[-4:])
check("no refused call wrote anything on the NAS", not nas.puts and not nas.deletes,
      (nas.puts, nas.deletes))

# =============================================================================
# A) update-event on a recurring series keeps everything it did not touch
# =============================================================================
print("\n--- A: update-event(series-1, summary) keeps the rest of the ICS")
nas.clear()
err, text = m.call("update-event", uid="series-1", calendarUrl=CAL, summary="Neuer Titel")
puts = list(nas.puts)
check("A1 update-event(series-1) succeeds", not err, text)
check("A2 it sends exactly one PUT", len(puts) == 1, [p[0] for p in puts])
a_path, a_headers, a_body = puts[0] if puts else (None, {}, "")
check("A3 the PUT goes to /<calendar>/series-1.ics", a_path == CAL + "series-1.ics", a_path)
check("A4 the PUT carries an If-Match header",
      any(k.lower() == "if-match" for k in a_headers), sorted(a_headers))
check("A5 the VTIMEZONE component survives",
      bool(blocks(a_body, "VTIMEZONE")) and "TZID:Europe/Berlin" in ics_lines(a_body), a_body)
master, override = master_and_override(a_body)
check("A6 both VEVENTs survive (master + RECURRENCE-ID override)",
      len(blocks(a_body, "VEVENT")) == 2 and bool(master) and bool(override),
      [len(blocks(a_body, "VEVENT")), bool(master), bool(override)])
check("A7 the override keeps RECURRENCE-ID;TZID=Europe/Berlin:20260928T100000",
      "RECURRENCE-ID;TZID=Europe/Berlin:20260928T100000" in ics_lines(a_body), a_body)
check("A8 the override keeps its own SUMMARY",
      one_value(override, "SUMMARY") == "Teambesprechung verschoben", one_value(override, "SUMMARY"))
check("A9 EXDATE;TZID=Europe/Berlin:20260921T100000 is unchanged",
      "EXDATE;TZID=Europe/Berlin:20260921T100000" in ics_lines(a_body), props(master, "EXDATE"))
att = props(master, "ATTENDEE")
check("A10 the ATTENDEE keeps CN, PARTSTAT and RSVP",
      len(att) == 1 and all(x in att[0] for x in
                            ("CN=Anna", "PARTSTAT=ACCEPTED", "RSVP=TRUE", "mailto:anna@example.org")), att)
check("A11 the ORGANIZER survives",
      any("mailto:thomas@example.org" in l for l in props(master, "ORGANIZER")),
      props(master, "ORGANIZER"))
check("A12 DTSTART;TZID=Europe/Berlin:20260907T100000 is byte-identical",
      "DTSTART;TZID=Europe/Berlin:20260907T100000" in ics_lines(a_body), props(master, "DTSTART"))
check("A13 no DTSTART carries both a TZID and a Z",
      not re.search(r"DTSTART;[^:\r\n]*TZID=[^:\r\n]*:\d{8}T\d{6}Z", unfold(a_body)),
      props(master, "DTSTART"))
check("A14 RRULE:FREQ=WEEKLY;COUNT=10 survives",
      "FREQ=WEEKLY" in (one_value(master, "RRULE") or "") and
      "COUNT=10" in (one_value(master, "RRULE") or ""), props(master, "RRULE"))
check("A15 the master SUMMARY is the new one", one_value(master, "SUMMARY") == "Neuer Titel",
      one_value(master, "SUMMARY"))
seq = one_value(master, "SEQUENCE", "")
check("A16 SEQUENCE is higher than 2", seq.isdigit() and int(seq) > 2, seq)

# =============================================================================
# B) an all-day event must not drift
# =============================================================================
print("\n--- B: update-event(allday-1, summary) does not move the day")
err, text, path, headers, body = put_after(m, "update-event", uid="allday-1",
                                           calendarUrl=CAL, summary="X")
check("B1 update-event(allday-1) sends exactly one PUT", path == CAL + "allday-1.ics", (text, path))
check("B2 DTSTART;VALUE=DATE:20260922 unchanged",
      "DTSTART;VALUE=DATE:20260922" in ics_lines(body), props(blocks(body, "VEVENT")[0] if blocks(body, "VEVENT") else [], "DTSTART"))
check("B3 DTEND;VALUE=DATE:20260923 unchanged",
      "DTEND;VALUE=DATE:20260923" in ics_lines(body), props(blocks(body, "VEVENT")[0] if blocks(body, "VEVENT") else [], "DTEND"))
check("B4 the day did not become a DATE-TIME",
      not re.search(r"DT(START|END)[^:\r\n]*:\d{8}T", unfold(body)), body)

# =============================================================================
# C) a timed event moved by offset lands in UTC
# =============================================================================
print("\n--- C: update-event(plain-1, start/end with +02:00)")
err, text, path, headers, body = put_after(m, "update-event", uid="plain-1", calendarUrl=CAL,
                                           start="2026-09-24T11:00:00+02:00",
                                           end="2026-09-24T12:00:00+02:00")
check("C1 DTSTART:20260924T090000Z", "DTSTART:20260924T090000Z" in ics_lines(body), (text, body))
check("C2 DTEND:20260924T100000Z", "DTEND:20260924T100000Z" in ics_lines(body), body)

# =============================================================================
# D) create-event with wholeDay: DTEND is the day after the last day
# =============================================================================
print("\n--- D: create-event(wholeDay) writes an exclusive DTEND")
err, text, path, headers, body = put_after(m, "create-event", summary="Feiertag", wholeDay=True,
                                           calendarUrl=CAL, start="2026-10-03T00:00:00+02:00",
                                           end="2026-10-03T00:00:00+02:00")
check("D1 one day: DTSTART;VALUE=DATE:20261003",
      "DTSTART;VALUE=DATE:20261003" in ics_lines(body), (text, body))
check("D2 one day: DTEND;VALUE=DATE:20261004 (exclusive, so exactly 3 Oct)",
      "DTEND;VALUE=DATE:20261004" in ics_lines(body), body)
err, text, path, headers, body = put_after(m, "create-event", summary="Kurzurlaub", wholeDay=True,
                                           calendarUrl=CAL, start="2026-10-03T00:00:00+02:00",
                                           end="2026-10-05T00:00:00+02:00")
check("D3 three days: DTSTART;VALUE=DATE:20261003",
      "DTSTART;VALUE=DATE:20261003" in ics_lines(body), (text, body))
check("D4 three days: DTEND;VALUE=DATE:20261006",
      "DTEND;VALUE=DATE:20261006" in ics_lines(body), body)

# =============================================================================
# E) complete-todo keeps the task it ticks off
# =============================================================================
print("\n--- E: complete-todo(todo-1) keeps RRULE, DUE and CATEGORIES")
err, text, path, headers, body = put_after(m, "complete-todo", uid="todo-1", calendarUrl=CAL)
vtodo = blocks(body, "VTODO")[0] if blocks(body, "VTODO") else []
check("E1 complete-todo sends one PUT to /<calendar>/todo-1.ics", path == CAL + "todo-1.ics",
      (text, path))
check("E2 RRULE:FREQ=WEEKLY verbatim", "RRULE:FREQ=WEEKLY" in ics_lines(body), props(vtodo, "RRULE"))
check("E3 DUE;VALUE=DATE:20260925 verbatim", "DUE;VALUE=DATE:20260925" in ics_lines(body),
      props(vtodo, "DUE"))
check("E4 CATEGORIES:Haus,Garten verbatim", "CATEGORIES:Haus,Garten" in ics_lines(body),
      props(vtodo, "CATEGORIES"))
check("E5 STATUS:COMPLETED", one_value(vtodo, "STATUS") == "COMPLETED", props(vtodo, "STATUS"))
check("E6 a COMPLETED:<UTC timestamp> property",
      bool(re.match(r"^\d{8}T\d{6}Z$", one_value(vtodo, "COMPLETED", ""))), props(vtodo, "COMPLETED"))
garbage = [l for l in ics_lines(body) if not NAME.match(l) or re.search(r"[:;]\d+=", l)]
check("E7 no garbage property like \"0=F\" anywhere", not garbage, garbage or body)

# =============================================================================
# F) update-todo changes only what it was told to change
# =============================================================================
print("\n--- F: update-todo(todo-1, summary) touches nothing else")
err, text, path, headers, body = put_after(m, "update-todo", uid="todo-1", calendarUrl=CAL,
                                           summary="Neu")
vtodo = blocks(body, "VTODO")[0] if blocks(body, "VTODO") else []
check("F1 SUMMARY is the new one", one_value(vtodo, "SUMMARY") == "Neu", (text, props(vtodo, "SUMMARY")))
check("F2 RRULE:FREQ=WEEKLY verbatim", "RRULE:FREQ=WEEKLY" in ics_lines(body), props(vtodo, "RRULE"))
check("F3 DUE;VALUE=DATE:20260925 verbatim", "DUE;VALUE=DATE:20260925" in ics_lines(body),
      props(vtodo, "DUE"))
check("F4 CATEGORIES:Haus,Garten verbatim", "CATEGORIES:Haus,Garten" in ics_lines(body),
      props(vtodo, "CATEGORIES"))
check("F5 STATUS stays NEEDS-ACTION and nothing was completed",
      one_value(vtodo, "STATUS") == "NEEDS-ACTION" and not props(vtodo, "COMPLETED"),
      (props(vtodo, "STATUS"), props(vtodo, "COMPLETED")))

# =============================================================================
# G) list-events expands the series into occurrences
# =============================================================================
print("\n--- G: list-events(2026-09-20 .. 2026-10-05)")
nas.clear()
raw = m.raw("list-events", calendarUrl=CAL, start="2026-09-20T00:00:00Z",
            end="2026-10-05T00:00:00Z")
texts = [c.get("text", "") for c in raw.get("content", []) if c.get("type") == "text"]
check("G1 one text content that is a JSON array",
      len(texts) == 1 and isinstance(json.loads(texts[0] or "null"), list), raw)
try:
    events = json.loads(texts[0])
except Exception:
    events = []
ALLOWED = {"uid", "summary", "start", "end", "description", "location", "wholeDay",
           "recurring", "recurrenceId"}
check("G2 every entry is an object with uid, summary, start, end and no unknown key",
      bool(events) and all(isinstance(e, dict) and {"uid", "summary", "start", "end"} <= set(e)
                           and set(e) <= ALLOWED for e in events), events)
by_uid = {}
for e in events if isinstance(events, list) else []:
    by_uid.setdefault(e.get("uid"), []).append(e)
series = by_uid.get("series-1", [])
check("G3 the series appears once in the window (21 Sep dropped by EXDATE, 14 Sep and 5 Oct outside)",
      len(series) == 1, series)
occ = series[0] if len(series) == 1 else {}
check("G4 that occurrence starts 2026-09-28T12:00:00Z (14:00 Berlin, the override)",
      instant(occ.get("start")) == at(2026, 9, 28, 12), occ.get("start"))
check("G5 ... and ends 2026-09-28T13:00:00Z", instant(occ.get("end")) == at(2026, 9, 28, 13),
      occ.get("end"))
check("G6 ... with the override's own summary", occ.get("summary") == "Teambesprechung verschoben",
      occ.get("summary"))
check("G7 ... marked recurring: true", occ.get("recurring") is True, occ)
check("G8 ... with a recurrenceId of the original occurrence (2026-09-28T08:00:00Z)",
      instant(occ.get("recurrenceId")) == at(2026, 9, 28, 8), occ.get("recurrenceId"))
check("G9 no occurrence on 21 Sep (EXDATE) and none on 14 Sep or 5 Oct (outside)",
      not [e for e in series if instant(e.get("start")) in
           (at(2026, 9, 21, 8), at(2026, 9, 14, 8), at(2026, 10, 5, 8))], series)
allday = by_uid.get("allday-1", [])
check("G10 the all-day event appears once with wholeDay: true",
      len(allday) == 1 and allday[0].get("wholeDay") is True, allday)
check("G11 ... start is the date-only string \"2026-09-22\"",
      len(allday) == 1 and allday[0].get("start") == "2026-09-22", allday)
check("G12 ... end is the date-only string \"2026-09-22\" (inclusive, no timestamp)",
      len(allday) == 1 and allday[0].get("end") == "2026-09-22", allday)
plain = by_uid.get("plain-1", [])
check("G13 the plain event appears once", len(plain) == 1, plain)
check("G14 ... at 09:00Z-10:00Z",
      len(plain) == 1 and instant(plain[0].get("start")) == at(2026, 9, 24, 9)
      and instant(plain[0].get("end")) == at(2026, 9, 24, 10), plain)
check("G15 ... with neither wholeDay nor recurring",
      len(plain) == 1 and "wholeDay" not in plain[0] and "recurring" not in plain[0], plain)
check("G16 the list is sorted by start",
      [e.get("uid") for e in events] == ["allday-1", "plain-1", "series-1"],
      [(e.get("uid"), e.get("start")) for e in events])

print("\n--- G': list-events(2026-09-01 .. 2026-09-20), the plain occurrences")
raw2 = m.raw("list-events", calendarUrl=CAL, start="2026-09-01T00:00:00Z",
             end="2026-09-20T00:00:00Z")
try:
    events2 = json.loads("\n".join(c.get("text", "") for c in raw2.get("content", [])))
except Exception:
    events2 = []
series2 = [e for e in events2 if isinstance(e, dict) and e.get("uid") == "series-1"]
starts2 = sorted((instant(e.get("start")) for e in series2), key=lambda d: d or at(1970, 1, 1))
check("G17 7 and 14 Sep appear once each", starts2 == [at(2026, 9, 7, 8), at(2026, 9, 14, 8)],
      [e.get("start") for e in series2])
check("G18 each is recurring with its own occurrence as recurrenceId",
      len(series2) == 2 and all(e.get("recurring") is True
                                and instant(e.get("recurrenceId")) == instant(e.get("start"))
                                for e in series2), series2)
check("G19 every occurrence keeps the master summary",
      len(series2) == 2 and all(e.get("summary") == "Teambesprechung" for e in series2), series2)

# =============================================================================
# H) delete-event still deletes exactly one object, with If-Match
# =============================================================================
print("\n--- H: delete-event(plain-1)")
nas.clear()
err, text = m.call("delete-event", uid="plain-1", calendarUrl=CAL)
check("H1 DELETE goes to /<calendar>/plain-1.ics",
      [d[0] for d in nas.deletes] == [CAL + "plain-1.ics"], (err, text, nas.deletes))
check("H2 the DELETE carries an If-Match header",
      bool(nas.deletes) and any(k.lower() == "if-match" for k in nas.deletes[0][1]),
      nas.deletes[0][1] if nas.deletes else None)

m.close()

print(f"\n{total} checks, {failures} failed" if failures else f"\n{total} checks, all passed")
sys.exit(1 if failures else 0)
