# Changelog

## Unreleased – 2026-09-22

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
  retrieve vevents from the CalDAV server"* in 1.1.3 and earlier. Not published as a release yet.

## 1.1.3 – 2026-07-31

- The connection to the NAS is opened on the first tool call instead of at startup, so a slow NAS no longer breaks the
  MCP handshake. The calendar list is fetched per call. Not published as a release yet.

## 1.1.2 – 2026-07-31

- New setting **Zeitlimit pro Anfrage** (seconds, default 45); it reaches the server as `CALDAV_TIMEOUT`.

## 1.1.1 – 2026-07-31

- The CalDAV path `/caldav/` is appended by the extension, because DSM defeats ts-caldav's own discovery.
- ts-caldav's request timeout of 5 seconds is raised, so the slow first DSM login fits. Not published as a release.

## 1.1.0 – 2026-07-31

- First public release. Setup asks for a host name and an HTTPS switch instead of a URL.
