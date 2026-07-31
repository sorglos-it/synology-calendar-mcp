# synology-calendar-mcp

[![Claude Desktop](https://img.shields.io/badge/Claude%20Desktop-extension-d97757.svg)](#)
[![Protocol](https://img.shields.io/badge/protocol-CalDAV-0b7285.svg)](#)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933.svg?logo=node.js&logoColor=white)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Donate](https://img.shields.io/badge/Donate-PayPal-00457C.svg?logo=paypal)](https://www.paypal.com/donate/?hosted_button_id=6CDEVZGJWTNQQ)

Claude Desktop extension that gives Claude access to the **Calendar app of a Synology NAS** — or to any other CalDAV server. List calendars, read events in a date range, create, change and delete appointments and todos, straight from a conversation. Ships as a single `.mcpb` file: install, fill in four fields, done.

Setup asks for a **host name and a protocol switch**, never a URL. The extension assembles the endpoint itself, which removes the single most common way to get CalDAV configuration wrong.

See also **[synology-contacts-mcp](https://github.com/sorglos-it/synology-contacts-mcp)** — the same idea for contacts over CardDAV — and **[github-mcp](https://github.com/sorglos-it/github-mcp)** for repositories on github.com.

## Features

- **Events** — list by date range, create, update, delete; all-day and recurring events included
- **Todos** — list (optionally filtered by status), create, update, complete, delete
- **No URL to get right** — host name plus an HTTPS switch; ports default to the DSM values 5001 (https) and 5000 (http)
- **Forgiving input** — a pasted `https://`, a trailing path or an explicit `:port` are handled instead of rejected
- **Self-signed certificates** — one switch, no manual `NODE_TLS_REJECT_UNAUTHORIZED` fiddling
- **Runs locally** — the server talks to your NAS directly; nothing is sent to a third party
- **No credentials in the package** — Claude Desktop stores the password in the OS keychain
- **Nothing to install** — Node ships with Claude Desktop, all dependencies are in the `.mcpb`

## Requirements

- Claude Desktop 0.10.0 or newer (Windows, macOS, Linux)
- A reachable Synology NAS with the Calendar app installed and CalDAV enabled
- A DSM user account that owns the calendars

## Installation

1. Grab `synology-calendar-1.1.3.mcpb` from [Releases](https://github.com/sorglos-it/synology-calendar-mcp/releases), or build it yourself (see below).
2. Claude Desktop → **Settings → Extensions → Advanced settings → Install extension…**, pick the file. Drag and drop onto the extensions window works too.
3. Fill in the fields (see next section) and enable the extension.
4. Ask Claude something like *"which calendars do I have?"*.

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

## How it works

1. Claude Desktop starts `index.js` with the configured fields as environment variables.
2. The wrapper builds `CALDAV_BASE_URL` from host name and protocol switch and appends the CalDAV path `/caldav/`. ts-caldav can find that path by itself on most servers, but not on DSM: its well-known probe uses GET where DSM only answers OPTIONS, and its fallback candidates carry no trailing slash where DSM insists on one. Discovery would fall back to the bare origin, DSM serves the web UI there, and no principal is ever found.
3. With certificate checking off, `NODE_TLS_REJECT_UNAUTHORIZED=0` is set before anything connects.
4. The bundled [caldav-mcp](https://github.com/dominik1001/caldav-mcp) server takes over, exposes the ten tools over stdio and answers the MCP handshake immediately. The NAS is contacted on the first tool call, not at startup.

`CALDAV_BASE_URL` is still honoured if you set it directly, and wins over the host name — useful for a server that lives behind a path.

## Environment variables

Useful if you want to run the server standalone rather than as an extension:

| Variable | Meaning |
|---|---|
| `CALDAV_HOST` | Host name, `:port` optional |
| `CALDAV_HTTPS` | `true` (default) → https + port 5001, `false` → http + port 5000 |
| `CALDAV_USERNAME` | DSM login name |
| `CALDAV_PASSWORD` | DSM password |
| `CALDAV_VERIFY_SSL` | `false` for a self-signed certificate |
| `CALDAV_TIMEOUT` | Seconds per request, default `45`. Blank or unparsable falls back to the default. |
| `CALDAV_BASE_URL` | Legacy: a complete endpoint URL, wins over `CALDAV_HOST` |

```bash
node index.js
```

## Notes & caveats

- **Shared calendars can be read-only.** Synology hands out team calendars without write privileges in some configurations; writes then fail with HTTP 403.
- **The connection is opened on first use, not at startup.** A wrong password or an unreachable NAS therefore surfaces as an error on the tool that needed it, and the next call tries again. Up to and including 1.1.2 the server connected before it spoke MCP, so a NAS that stayed quiet for a minute cost the whole handshake and Claude Desktop reported *"Verbindung zum Erweiterungs-Server nicht möglich"* — an extension that looked broken while only the NAS was slow.
- **Certificate checking off means exactly that.** It disables TLS verification for the whole Node process. It is the right setting for a NAS with a self-signed certificate on your own LAN, and the wrong one over the open internet.
- **The German field labels are not a bug**, just the language the manifest was written in.
- **DSM is slow to authenticate.** The first authenticated request of a session regularly takes five seconds or more, later ones come from its session cache in milliseconds. ts-caldav hardcodes a 5000 ms timeout that caldav-mcp never overrides, so the wrapper raises it to 45 s before the server starts. The **Zeitlimit pro Anfrage** field changes that; it reaches the wrapper as `CALDAV_TIMEOUT`, in seconds, and a blank or unparsable value falls back to 45 rather than stopping the server. A NAS that needs several seconds per request on every call is worth looking at on the DSM side — a directory-service lookup running into its own timeout produces exactly that pattern.

## Building the .mcpb yourself

```bash
npm install --prefix server --omit=dev
npx @anthropic-ai/mcpb pack . synology-calendar-1.1.3.mcpb
```

`server/` holds the caldav-mcp package; only its `node_modules` are left out of this repository. Two files differ from upstream: `server/dist/index.js` builds the CalDAV client lazily instead of before the MCP handshake, and `server/dist/tools/list-calendars.js` fetches the calendar list per call instead of once at registration. Both changes are commented in place. To move to a newer caldav-mcp, replace the contents of `server/`, re-apply those two changes and bump the version in `manifest.json`.

## Credits

Built around [caldav-mcp](https://github.com/dominik1001/caldav-mcp) by Dominik Grusemann (MIT), bundled with the two startup changes described under *Building the .mcpb yourself*.

## Support this project ❤️

If this extension saved you time, you can support further development:

[![Donate with PayPal](https://www.paypalobjects.com/en_US/i/btn/btn_donate_LG.gif)](https://www.paypal.com/donate/?hosted_button_id=6CDEVZGJWTNQQ)

**[➡️ Donate via PayPal](https://www.paypal.com/donate/?hosted_button_id=6CDEVZGJWTNQQ)**

## License

This project is licensed under the [MIT License](LICENSE) — © 2026 Thomas Weirich.
