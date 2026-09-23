import { z } from "zod";
import { patchEvent } from "./caldav-ical.js";
import { damaged, findObject, writeObject } from "./caldav-objects.js";
// A weekday of a repetition, optionally with its number in the month
// ("2MO" = the second Monday). Free text here would smuggle its own rule
// parts into the RRULE line.
const bydaySchema = z
    .string()
    .regex(/^[+-]?(\d|[1-4]\d|5[0-3])?(MO|TU|WE|TH|FR|SA|SU)$/, "e.g. MO, FR or 2MO");
const recurrenceRuleSchema = z.object({
    freq: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]).optional(),
    interval: z.number().int().positive().max(1000).optional(),
    count: z.number().int().positive().max(5000).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    byday: z.array(bydaySchema).optional(),
    bymonthday: z.array(z.number().int().min(-31).max(31)).optional(),
    bymonth: z.array(z.number().int().min(1).max(12)).optional(),
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
        await writeObject(client, object, damaged(uid, () => patchEvent(object.ics, {
            ...(summary !== undefined && { summary }),
            ...(start !== undefined && { start }),
            ...(end !== undefined && { end }),
            ...(wholeDay !== undefined && { wholeDay }),
            ...(description !== undefined && { description }),
            ...(location !== undefined && { location }),
            ...(recurrenceRule !== undefined && { recurrenceRule }),
        })));
        return {
            content: [{ type: "text", text: uid }],
        };
    });
}
