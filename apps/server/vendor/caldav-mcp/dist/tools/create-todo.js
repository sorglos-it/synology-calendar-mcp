import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildTodo } from "./caldav-ical.js";
import { createObject } from "./caldav-objects.js";
import { todoStatusSchema } from "./todo-status.js";
export const createTodoDefinition = {
    name: "create-todo",
    description: "Creates a task (VTODO) in the calendar specified by its URL. Only `summary` is required; a task may have no dates. Use `due` for a deadline and `start` for when work should begin.",
    inputSchema: {
        summary: z.string(),
        calendarUrl: z.string(),
        due: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe("Due datetime (ISO 8601)"),
        start: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe("Start datetime (ISO 8601)"),
        description: z.string().optional(),
        location: z.string().optional(),
        status: todoStatusSchema
            .optional()
            .describe("Defaults to NEEDS-ACTION when omitted"),
    },
    returns: "The unique ID of the created todo",
};
export function registerCreateTodo(client, server) {
    server.registerTool(createTodoDefinition.name, {
        description: createTodoDefinition.description,
        inputSchema: createTodoDefinition.inputSchema,
    }, async (args) => {
        const { calendarUrl, summary, due, start, description, location, status, } = args;
        // written here, like the events: see create-event.js
        const uid = randomUUID();
        await createObject(client, calendarUrl, uid, buildTodo({
            uid, summary,
            ...(due !== undefined && { due }),
            ...(start !== undefined && { start }),
            ...(description !== undefined && { description }),
            ...(location !== undefined && { location }),
            ...(status !== undefined && { status }),
        }));
        return {
            content: [{ type: "text", text: uid }],
        };
    });
}
