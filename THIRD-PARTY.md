# Third-party code

synology-calendar-mcp is MIT-licensed (see [LICENSE](LICENSE)). It ships code from other projects.

## caldav-mcp

| | |
|---|---|
| Where | `apps/server/vendor/caldav-mcp/` — `dist/`, `package.json`, `README.md`, `LICENSE` |
| Origin | [dominik1001/caldav-mcp](https://github.com/dominik1001/caldav-mcp), npm package `caldav-mcp` 0.10.0. The npm package holds only the compiled JavaScript (`dist/`); its TypeScript sources are in the upstream repository. |
| Copied | 2026-07-31, with extension 1.1.0 |
| Licence | MIT, © 2025 Dominik Grusemann — [`apps/server/vendor/caldav-mcp/LICENSE`](apps/server/vendor/caldav-mcp/LICENSE) |
| Own changes | `dist/index.js` (1.1.3, 1.1.4, 1.1.5): the CalDAV client is built on the first tool call instead of before the MCP handshake, and every calendar URL is made absolute against the base URL — and refused unless it is on the base URL's origin and free of `?` and `#`. `dist/tools/list-calendars.js` (1.1.3): the calendar list is fetched per call instead of once at registration. `dist/tools/caldav-href.js` (1.1.5): a uid with `/`, `\`, `?`, `#`, `%` or control characters is refused. `dist/tools/caldav-ical.js` and `dist/tools/caldav-objects.js` (1.1.5) are ours, not caldav-mcp's: they read and change the iCalendar objects themselves, and `update-event.js`, `update-todo.js`, `complete-todo.js`, `list-events.js`, `list-todos.js` and `create-event.js` (1.1.5) use them instead of rebuilding an object from ts-caldav's model. They use `ical.js` and `fast-xml-parser` directly, which is why both now stand in `package.json` as dependencies (they were already installed for ts-caldav). All changes are commented in place. All other files are the npm release unchanged (line endings aside). |

To move to a newer caldav-mcp: replace `dist/`, `package.json`, `README.md` and `LICENSE` with the new release, apply
these changes again, update this table, then install the dependencies and build (see README → Development).

## Dependencies of caldav-mcp

They are not stored in this repository. `npm install --prefix apps/server/vendor/caldav-mcp --omit=dev
--ignore-scripts` puts them into `apps/server/vendor/caldav-mcp/node_modules/`, and `tools/build.py` packs them into
the `.mcpb`, each with its own licence file. caldav-mcp uses `@modelcontextprotocol/sdk` (MIT), `ts-caldav` (ISC),
`zod` (MIT), `ical.js` (MPL-2.0) and `fast-xml-parser` (MIT) directly. For 1.1.5 that came to 117 packages: 105 MIT,
8 ISC, 2 BSD-3-Clause, 1 BSD-2-Clause and `ical.js` 2.2.1 under MPL-2.0, shipped unchanged (source:
[kewisch/ical.js](https://github.com/kewisch/ical.js)).

`apps/server/index.js` reaches into `ts-caldav` (`node_modules/ts-caldav/dist/index.mjs`): it wraps
`CalDAVClient.create` to raise the request timeout, send the credentials as UTF-8 and explain a rejected certificate,
and replaces `CalDAVClient.prototype.tryDiscoveryRoots` to ask the base URL before the discovery probes — check these
after an update.
