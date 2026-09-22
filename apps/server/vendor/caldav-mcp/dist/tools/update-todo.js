import { z } from "zod";
import { patchTodo } from "./caldav-ical.js";
import { findObject, writeObject } from "./caldav-objects.js";
import { todoStatusSchema } from "./todo-status.js";
export const updateTodoDefinition = {
    name: "update-todo",
    description: "Updates an existing task (VTODO) in the calendar specified by its URL. Only provided fields are changed; the repetition rule, categories and everything else of the task stay as they are. To mark a task done, prefer the `complete-todo` tool.",
    inputSchema: {
        uid: z
            .string()
            .describe("Unique identifier of the todo to update (from list-todos)"),
        calendarUrl: z.string(),
        summary: z.string().optional(),
        due: z.string().datetime({ offset: true }).optional(),
        start: z.string().datetime({ offset: true }).optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        status: todoStatusSchema.optional(),
    },
    returns: "The unique ID of the updated todo",
};
export function registerUpdateTodo(client, server) {
    server.registerTool(updateTodoDefinition.name, {
        description: updateTodoDefinition.description,
        inputSchema: updateTodoDefinition.inputSchema,
    }, async (args) => {
        const { uid, calendarUrl, summary, due, start, description, location, status, } = args;
        const object = await findObject(client, calendarUrl, "VTODO", uid);
        if (!object) {
            throw new Error(`Todo not found: ${uid}`);
        }
        // patchTodo keeps STATUS and the COMPLETED timestamp consistent
        // (RFC 5545): a task that becomes COMPLETED gets one, a task that
        // leaves that status loses it. An existing one is kept - completion
        // happened once.
        await writeObject(client, object, patchTodo(object.ics, {
            ...(summary !== undefined && { summary }),
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
