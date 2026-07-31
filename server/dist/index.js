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
let connection = null;
function connect() {
    // Cleared on failure so a NAS that was merely asleep is retried on the next
    // call instead of poisoning the process until Claude Desktop is restarted.
    connection ??= CalDAVClient.create({
        baseUrl: process.env.CALDAV_BASE_URL || "",
        auth: {
            type: "basic",
            username: process.env.CALDAV_USERNAME || "",
            password: process.env.CALDAV_PASSWORD || "",
        },
    }).catch((error) => {
        connection = null;
        throw new Error(`Keine Verbindung zum CalDAV-Server (${process.env.CALDAV_BASE_URL || "keine Adresse konfiguriert"}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
    return connection;
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
            const caldav = await connect();
            return caldav[method](...args);
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
