import { z } from "zod";
import { patchTodo } from "./caldav-ical.js";
import { findObject, writeObject } from "./caldav-objects.js";
export const completeTodoDefinition = {
    name: "complete-todo",
    description: "Marks a task (VTODO) as done. Sets its status to COMPLETED and records the completion time.",
    inputSchema: {
        uid: z
            .string()
            .describe("Unique identifier of the todo to complete (from list-todos)"),
        calendarUrl: z.string(),
    },
    returns: "The unique ID of the completed todo",
};
export function registerCompleteTodo(client, server) {
    server.registerTool(completeTodoDefinition.name, {
        description: completeTodoDefinition.description,
        inputSchema: completeTodoDefinition.inputSchema,
    }, async (args) => {
        const { uid, calendarUrl } = args;
        const object = await findObject(client, calendarUrl, "VTODO", uid);
        if (!object) {
            throw new Error(`Todo not found: ${uid}`);
        }
        // RFC 5545: a COMPLETED VTODO carries a COMPLETED timestamp, which
        // patchTodo adds. Everything else of the task - its repetition rule
        // above all - stays untouched.
        await writeObject(client, object, patchTodo(object.ics, { status: "COMPLETED" }));
        return {
            content: [{ type: "text", text: uid }],
        };
    });
}
