import { z } from "zod";
import { deleteObject, findObject } from "./caldav-objects.js";
export const deleteTodoDefinition = {
    name: "delete-todo",
    description: "Deletes a task (VTODO) in the calendar specified by its URL",
    inputSchema: {
        uid: z
            .string()
            .describe("Unique identifier of the todo to delete (from list-todos)"),
        calendarUrl: z.string(),
    },
    returns: "Confirmation message when the todo is successfully deleted",
};
export function registerDeleteTodo(client, server) {
    server.registerTool(deleteTodoDefinition.name, {
        description: deleteTodoDefinition.description,
        inputSchema: deleteTodoDefinition.inputSchema,
    }, async (args) => {
        const { uid, calendarUrl } = args;
        // deleted at its own address, and a missing task reads the same way
        // here as in complete-todo and update-todo
        const object = await findObject(client, calendarUrl, "VTODO", uid);
        if (!object) {
            throw new Error(`Todo not found: ${uid}`);
        }
        await deleteObject(client, object);
        return {
            content: [{ type: "text", text: "Todo deleted" }],
        };
    });
}
