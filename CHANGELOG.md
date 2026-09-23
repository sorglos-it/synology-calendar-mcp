# Changelog

## 1.1.7 – 2026-09-23

- **A moved date of a series is listed once**, even when the entry writes it in another time zone than the series
  itself — it used to appear twice, once as planned and once as moved.
- One damaged appointment inside an entry costs only itself; the others in the same entry are still listed.
- A repetition with more dates than can be worked out (a rule every minute since 2020) says so instead of quietly
  returning nothing, and dates that are over before the period begins are no longer worked out at all — that was
  seconds per call on a long series.
- Two appointments that share an identifier without belonging together are both listed again.

## 1.1.6 – 2026-09-23

- **One damaged entry no longer takes the whole calendar with it.** An event without a start date or a truncated
  object made `list-events` and `list-todos` answer with a parser error and nothing else. Such an object is now left
  out and named, and a change to one says which entry is at fault.
- **A series that started years ago is listed again.** Expansion walked at most 5000 dates from the start of the
  series, so a daily appointment running since 2013 had none left for this week.
- **A moved date is listed where it now is**, not where it used to be: one moved out of the period no longer appears
  in it, one moved into it is no longer missing.
- A whole-day series ends on a date (`UNTIL=20261231`), not at a moment — some servers refuse the timestamp form.
- Two unrelated appointments stored in one object are both listed again, and an instance carrying a foreign uid can
  no longer take the place of a real date of a series.
- An address with `&` in it no longer breaks the request that fetches the entry.

## 1.1.5 – 2026-09-22

- **Certificate checking is on by default** (*Zertifikat prüfen*): it keeps the DSM password from being intercepted.
  A NAS still on its self-signed certificate needs a valid one (e.g. Let's Encrypt) or the switch turned off — on your
  own network only. A rejected certificate is reported with the reason in plain words and both ways out instead of
  axios' bare *"self-signed certificate"*. Certificates trusted by the operating system count as well (Node.js 22.19 /
  24.5 or newer).
- **The DSM password stays on the NAS.** A calendar URL on another host — `https://elsewhere/`, `//elsewhere/` — was
  requested with the password in its Authorization header; one prompt injection in an event text was enough. Such
  URLs are now refused before anything is sent, and so is a calendar URL with `?` or `#`, behind which the delete of
  one event went to the whole calendar.
- **A uid can no longer leave its calendar.** Uids are chosen by whoever created the event, and one with `/`, `\`, `?`,
  `#` or `%` could make `delete-event` remove an object in another calendar or address the calendar itself. Such uids
  are refused.
- **An unreachable NAS costs one request timeout instead of eight.** Discovery asks the configured address first and
  probes `/.well-known/caldav` and five guessed paths only when that address answers with an error — six minutes at
  45 s before.
- **Changing an appointment or a task no longer throws the rest away.** Both were rebuilt from the handful of fields
  the CalDAV library knows, so renaming one appointment dropped everything else it carried: a moved date of a series
  (RECURRENCE-ID), a cancelled date (EXDATE), the attendees and their answers, the time zone, alarms — and a task lost
  its repetition rule and its categories, which came back as `RRULE:0=F;1=R;…`. Changes are now written into the
  object the server has, so only what was asked for changes. Moving the start of a series takes its cancelled and
  moved dates along, and giving only a new start keeps the appointment's length.
- **Whole-day appointments keep their date.** `2026-10-03` used to become 2 October — the date was read in UTC while
  Central European Time is two hours ahead — and every further change moved it another day.
- **`list-events` now lists every date of a recurring appointment** that falls in the period, cancelled dates left
  out and a moved date at its new time, instead of showing the series once on the day it started. Whole-day
  appointments come as dates (`2026-09-22`, `end` is the last day) with `wholeDay`, each date of a series as
  `recurring` with its `recurrenceId`, and the list is sorted by start.
- **`list-todos`: a deadline without a time stays a date.** It used to arrive as a timestamp at midnight local time,
  which reads as the day before in UTC.
- The bundled libraries `fast-uri`, `hono` and `qs` are updated: the versions shipped before had known
  vulnerabilities. None of them is reachable through this extension, which talks stdio and no HTTP of its own.
- A password with characters outside Latin-1 (€) no longer stops the connection, and umlauts are sent as UTF-8, like
  the contacts extension does.
- The **HTTPS verwenden** description says that switching it off sends the password unencrypted.
- First release since 1.1.2: it also carries the fixes of 1.1.3 and 1.1.4, which were never released on their own.
- Author is now „Sorglos Thomas Weirich“. Claude Desktop derives the extension's identity from it:
  uninstall the old extension once before installing this version, then enter the settings again.
- Project layout follows the project standard: the extension lives in `apps/server/` (`index.js`, `package.json`,
  `manifest.json`, `assets/icon.png`, `VERSION`), caldav-mcp moved from `server/` to `apps/server/vendor/caldav-mcp/`.
- Origin, licence and own changes of caldav-mcp are recorded in `THIRD-PARTY.md`, which also ships in the `.mcpb`.
- `tools/build.py` builds `dist/synology-calendar-<version>.mcpb` with Python alone — no `npx` needed any more — and
  stops when the dependencies are missing or the version numbers differ.
- The `.mcpb` keeps its contents apart from the new paths; the unused command shims from `node_modules/.bin` are left
  out.
- README rewritten: start in 3 steps, paths and build commands for the new layout.

## 1.1.4 – 2026-08-11

- Calendar URLs are made absolute before every request. `list-events` and `list-todos` failed with *"Failed to
  retrieve vevents from the CalDAV server"* in 1.1.3 and earlier. Not published as a release; shipped with 1.1.5.

## 1.1.3 – 2026-07-31

- The connection to the NAS is opened on the first tool call instead of at startup, so a slow NAS no longer breaks the
  MCP handshake. The calendar list is fetched per call. Not published as a release; shipped with 1.1.5.

## 1.1.2 – 2026-07-31

- New setting **Zeitlimit pro Anfrage** (seconds, default 45); it reaches the server as `CALDAV_TIMEOUT`.

## 1.1.1 – 2026-07-31

- The CalDAV path `/caldav/` is appended by the extension, because DSM defeats ts-caldav's own discovery.
- ts-caldav's request timeout of 5 seconds is raised, so the slow first DSM login fits. Not published as a release.

## 1.1.0 – 2026-07-31

- First public release. Setup asks for a host name and an HTTPS switch instead of a URL.
