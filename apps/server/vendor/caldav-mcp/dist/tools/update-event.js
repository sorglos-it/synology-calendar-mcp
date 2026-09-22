import { z } from "zod";
import { patchEvent } from "./caldav-ical.js";
import { findObject, writeObject } from "./caldav-objects.js";
const recurrenceRuleSchema = z.object({
    freq: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]).optional(),
    interval: z.number().optional(),
    count: z.number().optional(),
    until: z.string().datetime({ offset: true }).optional(),
    byday: z.array(z.string()).optional(),
    bymonthday: z.array(z.number()).optional(),
    bymonth: z.array(z.number()).optional(),
});
export const updateEventDefinition = {
    name: "update-event",
    description: "Updates an existing event in the calendar specified by its URL. Only provided fields are changed; everything else of the event (attendees, alarms, cancelled or moved dates of a series, time zone) stays as it is. Giving only `start` moves the event and keeps its length. A recurring event is changed as a whole. For a one-day full-day event, set `wholeDay` to true and set `start` and `end` to the same calendar day.",
    inputSchema: {
        uid: z
            .string()
            .describe("Unique identifier of the event to update (obtained from list-events)"),
        calendarUrl: z.string(),
        summary: z.string().optional(),
        start: z.string().datetime({ offset: true }).optional(),
        end: z.string().datetime({ offset: true }).optional(),
        wholeDay: z
            .boolean()
            .optional()
            .describe("Update whether this is a whole-day event"),
        description: z.string().optional(),
        location: z.string().optional(),
        recurrenceRule: recurrenceRuleSchema.optional(),
    },
    returns: "The unique ID of the updated event",
};
export function registerUpdateEvent(client, server) {
    server.registerTool(updateEventDefinition.name, {
        description: updateEventDefinition.description,
        inputSchema: updateEventDefinition.inputSchema,
    }, async (args) => {
        const { uid, calendarUrl, summary, start, end, wholeDay, description, location, recurrenceRule, } = args;
        // The object is changed where it lies instead of being rebuilt from a
        // handful of fields, which used to drop everything else it held.
        const object = await findObject(client, calendarUrl, "VEVENT", uid);
        if (!object) {
            throw new Error(`Event not found: ${uid}`);
        }
        await writeObject(client, object, patchEvent(object.ics, {
            ...(summary !== undefined && { summary }),
            ...(start !== undefined && { start }),
            ...(end !== undefined && { end }),
            ...(wholeDay !== undefined && { wholeDay }),
            ...(description !== undefined && { description }),
            ...(location !== undefined && { location }),
            ...(recurrenceRule !== undefined && { recurrenceRule }),
        }));
        return {
            content: [{ type: "text", text: uid }],
        };
    });
}
