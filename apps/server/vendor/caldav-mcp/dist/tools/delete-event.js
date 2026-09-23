import { z } from "zod";
import { deleteObject, findObject } from "./caldav-objects.js";
export const deleteEventDefinition = {
    name: "delete-event",
    description: "Deletes an event in the calendar specified by its URL",
    inputSchema: {
        uid: z
            .string()
            .describe("Unique identifier of the event to delete (obtained from list-events)"),
        calendarUrl: z.string(),
    },
    returns: "Confirmation message when the event is successfully deleted",
};
export function registerDeleteEvent(client, server) {
    server.registerTool(deleteEventDefinition.name, {
        description: deleteEventDefinition.description,
        inputSchema: deleteEventDefinition.inputSchema,
    }, async (args) => {
        const { uid, calendarUrl } = args;
        // deleted at its own address: an event the calendar app stored under
        // another file name than <uid>.ics was "not found" before
        const object = await findObject(client, calendarUrl, "VEVENT", uid);
        if (!object) {
            throw new Error(`Event not found: ${uid}`);
        }
        await deleteObject(client, object);
        return {
            content: [{ type: "text", text: "Event deleted" }],
        };
    });
}
