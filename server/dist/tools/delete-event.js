import { z } from "zod";
import { hrefFor } from "./caldav-href.js";
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
        const etag = await client.getETag(hrefFor(calendarUrl, uid));
        await client.deleteEvent(calendarUrl, uid, etag);
        return {
            content: [{ type: "text", text: "Event deleted" }],
        };
    });
}
