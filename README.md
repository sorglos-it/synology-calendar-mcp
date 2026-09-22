# synology-calendar-mcp

[![Claude Desktop](https://img.shields.io/badge/Claude%20Desktop-extension-d97757.svg)](#)
[![Protocol](https://img.shields.io/badge/protocol-CalDAV-0b7285.svg)](#)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933.svg?logo=node.js&logoColor=white)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Donate](https://img.shields.io/badge/Donate-PayPal-00457C.svg?logo=paypal)](https://www.paypal.com/donate/?hosted_button_id=6CDEVZGJWTNQQ)

Lets **Claude** use the **Calendar app of your Synology NAS** — or any other CalDAV server: list calendars, read the
events of a date range, create, change and delete appointments and todos, straight from a conversation. A Claude
Desktop extension in a single `.mcpb` file: install, fill in four fields, done.

| Folder | Purpose | Language | Start | Build |
|---|---|---|---|---|
| `apps/server` | MCP server: Claude's calendar and todo tools over CalDAV, built around caldav-mcp | JavaScript, Node.js ≥ 18 | install the `.mcpb` in Claude Desktop | `python tools/build.py` → `dist/synology-calendar-<version>.mcpb` (install the dependencies first, see [Development](#development)) |

## Start in 3 steps

You need Claude Desktop 0.10.0 or newer (Windows, macOS, Linux), a reachable Synology NAS with the Calendar app
installed and CalDAV enabled, and the DSM user account that owns the calendars. Nothing else to install — Node ships
with Claude Desktop, and all dependencies are inside the `.mcpb`.

1. **Get the extension** `synology-calendar-<version>.mcpb` from
   [Releases](https://github.com/sorglos-it/synology-calendar-mcp/releases), or build it yourself
   (see [Development](#development)).
2. **Install it in Claude Desktop:** *Settings → Extensions → Advanced settings → Install extension…*, pick the file.
   Dragging it onto the extensions window works too.
3. **Fill in the fields** (see [Configuration](#configuration)) and switch the extension on. Then ask Claude
   something like *"which calendars do I have?"*.

## Configuration

| Field | Meaning |
|---|---|
| **NAS-Adresse** | Host name or IP only, e.g. `nas.example.com`. No `https://`, no path. A non-standard port goes here as `nas.example.com:8443`. |
| **HTTPS verwenden** | On → `https`, default port 5001. Off → `http`, default port 5000. These are the DSM defaults. |
| **Benutzername** | DSM login name of the user who owns the calendars |
| **Passwort** | DSM password; stored in the OS keychain, never in the package |
| **Zertifikat prüfen** | Leave **off** while the NAS uses its self-signed certificate. Turn on for a real certificate (e.g. Let's Encrypt). |
| **Zeitlimit pro Anfrage** | Seconds allowed per request, default 45. Leave it alone unless the NAS is slow enough to run into it. |

The labels are German because the extension manifest is; the fields behave exactly as described above.

Setup asks for a **host name and a protocol switch**, never a URL. The extension assembles the endpoint itself, which
removes the single most common way to get CalDAV configuration wrong. Input is forgiving: a pasted `https://`, a
trailing path or an explicit `:port` are handled instead of rejected. A self-signed certificate needs one switch, no
manual `NODE_TLS_REJECT_UNAUTHORIZED` fiddling.

## Tools

| Tool | Purpose |
|---|---|
| `list-calendars` | All calendars with name and URL |
| `list-events` | Events in a date range |
| `create-event` | New event, optionally all-day or recurring |
| `update-event` | Change an existing event |
| `delete-event` | Remove an event |
| `list-todos` | Todos, optionally filtered by status |
| `create-todo` | New todo |
| `update-todo` | Change a todo |
| `complete-todo` | Mark a todo done |
| `delete-todo` | Remove a todo |

## Security and caveats

- **Runs locally.** The server talks to your NAS directly; nothing is sent to a third party. Claude Desktop stores the
  password in the OS keychain — there are no credentials in the package.
- **Certificate checking off means exactly that.** It disables TLS verification for the whole Node process. It is the
  right setting for a NAS with a self-signed certificate on your own LAN, and the wrong one over the open internet.
- **Shared calendars can be read-only.** Synology hands out team calendars without write privileges in some
  configurations; writes then fail with HTTP 403.
- **The connection is opened on first use, not at startup.** A wrong password or an unreachable NAS therefore surfaces
  as an error on the tool that needed it, and the next call tries again. Up to and including 1.1.2 the server
  connected before it spoke MCP, so a NAS that stayed quiet for a minute cost the whole handshake and Claude Desktop
  reported *"Verbindung zum Erweiterungs-Server nicht möglich"* — an extension that looked broken while only the NAS
  was slow.
- **Calendar URLs are absolutized before every request.** `list-calendars` returns bare paths — ts-caldav strips its
  calendar URLs to the pathname — and axios resolves a relative URL against the base URL rather than the origin, so
  `/caldav.php/user/home/` became `https://nas:5001/caldav/caldav.php/user/home/`. Reads died on it: `getComponents()`
  sends its REPORT without absolutizing and reports every failure as *"Failed to retrieve vevents from the CalDAV
  server"*, which is what 1.1.3 and earlier did for `list-events` and `list-todos` while writes still went through.
  The wrapper in `apps/server/vendor/caldav-mcp/dist/index.js` now resolves the URL for every client call, so passing
  a full `https://nas:5001/caldav.php/...` URL by hand is no longer needed.
- **DSM is slow to authenticate.** The first authenticated request of a session regularly takes five seconds or more,
  later ones come from its session cache in milliseconds. ts-caldav hardcodes a 5000 ms timeout that caldav-mcp never
  overrides, so the wrapper raises it to 45 s before the server starts. The **Zeitlimit pro Anfrage** field changes
  that; it reaches the wrapper as `CALDAV_TIMEOUT`, in seconds, and a blank or unparsable value falls back to 45 rather
  than stopping the server. A NAS that needs several seconds per request on every call is worth looking at on the DSM
  side — a directory-service lookup running into its own timeout produces exactly that pattern.

## Development

```text
apps/server/manifest.json       name, settings and start command of the extension (mcpb format)
apps/server/index.js            entry point: turns the settings into caldav-mcp's environment, then starts it
apps/server/package.json        marks index.js as an ES module
apps/server/assets/icon.png     icon shown in Claude Desktop
apps/server/VERSION             version, the same as in manifest.json and package.json
apps/server/vendor/caldav-mcp/  caldav-mcp 0.10.0 with our changes — origin and changes in THIRD-PARTY.md
tools/build.py                  packs apps/server, README.md, LICENSE and THIRD-PARTY.md into dist/synology-calendar-<version>.mcpb
```

```bash
npm install --prefix apps/server/vendor/caldav-mcp --omit=dev --ignore-scripts
python tools/build.py
```

The first line fetches the libraries caldav-mcp needs into `apps/server/vendor/caldav-mcp/node_modules/`; they are not
kept in this repository. The second one (Python 3.8 or newer, nothing else) packs everything into the `.mcpb` and stops
when a library is missing or when `VERSION`, `manifest.json` and `package.json` name different versions — raise all
three for a new version. How to move to a newer caldav-mcp is described in [THIRD-PARTY.md](THIRD-PARTY.md).

How it works:

1. Claude Desktop starts `index.js` with the configured fields as environment variables.
2. The wrapper builds `CALDAV_BASE_URL` from host name and protocol switch and appends the CalDAV path `/caldav/`.
   ts-caldav can find that path by itself on most servers, but not on DSM: its well-known probe uses GET where DSM
   only answers OPTIONS, and its fallback candidates carry no trailing slash where DSM insists on one. Discovery would
   fall back to the bare origin, DSM serves the web UI there, and no principal is ever found.
3. With certificate checking off, `NODE_TLS_REJECT_UNAUTHORIZED=0` is set before anything connects.
4. The bundled [caldav-mcp](https://github.com/dominik1001/caldav-mcp) server takes over, exposes the ten tools over
   stdio and answers the MCP handshake immediately. The NAS is contacted on the first tool call, not at startup.

To run the server without Claude Desktop, set the variables and start it from the project folder:

```bash
node apps/server/index.js
```

| Variable | Meaning |
|---|---|
| `CALDAV_HOST` | Host name, `:port` optional |
| `CALDAV_HTTPS` | `true` (default) → https + port 5001, `false` → http + port 5000 |
| `CALDAV_USERNAME` | DSM login name |
| `CALDAV_PASSWORD` | DSM password |
| `CALDAV_VERIFY_SSL` | `false` for a self-signed certificate |
| `CALDAV_TIMEOUT` | Seconds per request, default `45`. Blank or unparsable falls back to the default. |
| `CALDAV_BASE_URL` | Legacy: a complete endpoint URL, wins over `CALDAV_HOST` — useful for a server that lives behind a path |

See also **[synology-contacts-mcp](https://github.com/sorglos-it/synology-contacts-mcp)** — the same idea for contacts
over CardDAV — and **[github-mcp](https://github.com/sorglos-it/github-mcp)** for repositories on github.com.
Changes: [CHANGELOG.md](CHANGELOG.md).

## Credits

Built around [caldav-mcp](https://github.com/dominik1001/caldav-mcp) by Dominik Grusemann (MIT), bundled with the
changes described in [THIRD-PARTY.md](THIRD-PARTY.md).

## License

This project is licensed under the [MIT License](LICENSE) — © 2026 Sorglos Thomas Weirich. Third-party code:
[THIRD-PARTY.md](THIRD-PARTY.md).

## Donate via PayPal

If this extension saved you time, you can support further development:

[![Donate with PayPal](https://www.paypalobjects.com/en_US/i/btn/btn_donate_LG.gif)](https://www.paypal.com/donate/?hosted_button_id=6CDEVZGJWTNQQ)

**[➡️ Donate via PayPal](https://www.paypal.com/donate/?hosted_button_id=6CDEVZGJWTNQQ)**
