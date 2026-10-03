#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CalDAVClient } from "ts-caldav";
import { registerCompleteTodo } from "./tools/complete-todo.js";
import { registerCreateEvent } from "./tools/create-event.js";
import { registerCreateTodo } from "./tools/create-todo.js";
import { registerDeleteEvent } from "./tools/delete-event.js";
import { registerDeleteTodo } from "./tools/delete-todo.js";
import { registerListCalendars } from "./tools/list-calendars.js";
import { registerListEvents } from "./tools/list-events.js";
import { registerListTodos } from "./tools/list-todos.js";
import { registerUpdateEvent } from "./tools/update-event.js";
import { registerUpdateTodo } from "./tools/update-todo.js";
const server = new McpServer({
    name: "caldav-mcp",
    version: "0.1.0",
});
/*
 * The CalDAV connection is opened on the first tool call, not at startup.
 *
 * Claude Desktop gives an extension 60 seconds to answer "initialize" and
 * reports "Verbindung zum Erweiterungs-Server nicht möglich" when that window
 * passes. Building the client first spends that window on the NAS instead of on
 * MCP: discovery plus the first authenticated PROPFIND against a DSM that is
 * asleep, busy or unreachable can outlast it on its own, and with the request
 * timeout of the settings dialog at 45 seconds two slow requests are already
 * over budget. The handshake now completes in milliseconds and a NAS that does
 * not answer becomes an error on the tool that needed it.
 */
/*
 * Up to three NAS at once (1.2.0). The first is always there, the second and
 * third only when their address is filled in; ../../../index.js has settled
 * the variables of each before this file is loaded.
 */
const SERVERS = [1, 2, 3]
    .map((n) => {
    const slot = n === 1 ? "CALDAV" : `CALDAV${n}`;
    return {
        n,
        baseUrl: process.env[`${slot}_BASE_URL`] || "",
        username: process.env[`${slot}_USERNAME`] || "",
        password: process.env[`${slot}_PASSWORD`] || "",
        verify: process.env[`${slot}_VERIFY_SSL`] !== "false",
        connection: null,
    };
})
    .filter((nas) => nas.n === 1 || nas.baseUrl);
const SEVERAL = SERVERS.length > 1;
function connect(nas) {
    if (SEVERAL && !(nas.username && nas.password)) {
        return Promise.reject(new Error(`NAS ${nas.n} (${nas.baseUrl}) has no user name or no password. Fill in both in the extension settings, or clear its address.`));
    }
    // Cleared on failure so a NAS that was merely asleep is retried on the next
    // call instead of poisoning the process until Claude Desktop is restarted.
    nas.connection ??= CalDAVClient.create({
        baseUrl: nas.baseUrl,
        rejectUnauthorized: nas.verify,
        auth: {
            type: "basic",
            username: nas.username,
            password: nas.password,
        },
    }).catch((error) => {
        nas.connection = null;
        throw new Error(`Keine Verbindung zum CalDAV-Server (${nas.baseUrl || "keine Adresse konfiguriert"}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
    return nas.connection;
}
/*
 * Which NAS a calendar URL is on.
 *
 * With one NAS that is no question. With several, list-calendars puts the
 * number of the NAS in front of every URL - "2:/caldav.php/user/home/" - and
 * every tool hands it back unchanged. The number travels inside the URL rather
 * than as a parameter of its own because the paths look alike on every NAS: a
 * forgotten or mixed-up parameter would write the appointment into the
 * calendar of the same name on the wrong NAS, and nothing would notice. A URL
 * without a number is therefore refused instead of guessed.
 */
function route(url) {
    const numbered = url.match(/^([1-9]):(.*)$/s);
    if (!numbered) {
        if (SEVERAL) {
            throw new Error(`Refused: ${url} does not say which NAS it is on. Use a calendar URL from list-calendars - it starts with the number of the NAS, like "2:/caldav.php/...".`);
        }
        return [SERVERS[0], url];
    }
    const nas = SERVERS.find((candidate) => candidate.n === Number(numbered[1]));
    if (!nas) {
        throw new Error(`Refused: there is no NAS ${numbered[1]} in the extension settings. Use a calendar URL from list-calendars.`);
    }
    return [nas, numbered[2]];
}
/*
 * The calendars of every NAS. One that is asleep or refuses the login must not
 * hide the calendars of the others, so it is listed with what went wrong; only
 * when none of them answers is the whole call an error.
 */
async function allCalendars() {
    if (!SEVERAL)
        return (await connect(SERVERS[0])).getCalendars();
    const failed = [];
    const lists = await Promise.all(SERVERS.map(async (nas) => {
        let name = nas.baseUrl;
        try {
            name = `${nas.username}@${new URL(nas.baseUrl).host}`;
            const calendars = await (await connect(nas)).getCalendars();
            return calendars.map((calendar) => ({ ...calendar, url: `${nas.n}:${calendar.url}`, nas: name }));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failed.push(message);
            return [{ nas: name, error: message }];
        }
    }));
    if (failed.length === SERVERS.length)
        throw new Error(failed.join(" | "));
    return lists.flat();
}
/*
 * Turns the calendar URL of a tool call into an absolute one.
 *
 * list-calendars hands out bare paths - ts-caldav strips its calendar URLs to
 * the pathname - and axios resolves a relative URL against the *base URL*, not
 * against the origin. With a base of "https://nas:5001/caldav/" a calendar at
 * "/caldav.php/user/home/" therefore ends up as
 * "https://nas:5001/caldav/caldav.php/user/home/", which is not where DSM keeps
 * it. Reads die on that: getComponents() sends the REPORT without absolutizing
 * and turns every failure into "Failed to retrieve vevents from the CalDAV
 * server". Writes reach the NAS despite the doubled prefix, but they take the
 * same unresolved path, so this runs for all of them rather than only for the
 * two list tools.
 *
 * Every client method takes the calendar URL first, so only args[0] is touched.
 *
 * It also has to stay on the NAS - on the one it belongs to, see route(). Every request carries the DSM password in
 * its Authorization header, so a calendarUrl like "https://elsewhere/",
 * "//elsewhere/" or "/\elsewhere/" - one prompt injection in an event text
 * away - would hand the password to that host. Any URL whose origin is not the
 * base URL's is refused before a request is made.
 *
 * A "?" or "#" is refused as well: ts-caldav appends "/<uid>.ics" to the
 * calendar URL, and behind a "?" or "#" that part stops being path - the
 * DELETE of one event would go to the calendar itself.
 */
function absolutizeCalendarUrl(nas, args) {
    const [url] = args;
    if (typeof url !== "string")
        return args;
    let base;
    try {
        base = new URL(nas.baseUrl);
    }
    catch {
        throw new Error(`The NAS address is not valid (${nas.baseUrl || "empty"}). Check the NAS address: a name or IP, optionally followed by :port.`);
    }
    let target;
    try {
        target = new URL(url, base);
    }
    catch {
        throw new Error(`Not a calendar URL: ${url}`);
    }
    if (target.origin !== base.origin) {
        throw new Error(`Refused: ${url} is not on the NAS (${base.origin}). Use a calendar URL from list-calendars.`);
    }
    if (/[?#]/.test(target.href)) {
        throw new Error(`Refused: ${url} contains "?" or "#". Use a calendar URL from list-calendars.`);
    }
    return [target.toString(), ...args.slice(1)];
}
/*
 * Stands in for the real client while the tools are registered. Every tool uses
 * it the same way - "await client.someMethod(...)" - so forwarding methods is
 * enough and the tool files stay untouched.
 */
const client = new Proxy({}, {
    get(_target, method) {
        // Symbols and "then" must stay undefined: a proxy that hands out a
        // "then" function looks like a promise, and awaiting one would hang.
        if (typeof method === "symbol" || method === "then")
            return undefined;
        return async (...args) => {
            if (method === "getCalendars")
                return allCalendars();
            const [nas, url] = typeof args[0] === "string" ? route(args[0]) : [SERVERS[0], args[0]];
            const checked = absolutizeCalendarUrl(nas, [url, ...args.slice(1)]);
            const caldav = await connect(nas);
            return caldav[method](...checked);
        };
    },
});
async function main() {
    registerCreateEvent(client, server);
    registerListEvents(client, server);
    registerDeleteEvent(client, server);
    registerUpdateEvent(client, server);
    registerCreateTodo(client, server);
    registerListTodos(client, server);
    registerUpdateTodo(client, server);
    registerCompleteTodo(client, server);
    registerDeleteTodo(client, server);
    await registerListCalendars(client, server);
    // Start receiving messages on stdin and sending messages on stdout
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((error) => {
    console.error("❌ Failed to start the CalDAV MCP server:", error);
    process.exit(1);
});
