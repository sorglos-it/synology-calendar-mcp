import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildEvent } from "./caldav-ical.js";
import { createObject } from "./caldav-objects.js";
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
    until: z.string().datetime({ offset: true }).optional(), // ISO 8601 string
    byday: z.array(bydaySchema).optional(), // e.g. ["MO", "TU"]
    bymonthday: z.array(z.number().int().min(-31).max(31)).optional(),
    bymonth: z.array(z.number().int().min(1).max(12)).optional(),
});
export const createEventDefinition = {
    name: "create-event",
    description: "Creates an event in the calendar specified by its URL. For all-day events, set `wholeDay` to true. For a single-day all-day event, use `start` and `end` datetimes on the same calendar date; they do not need to be identical timestamps.",
    inputSchema: {
        summary: z.string(),
        start: z
            .string()
            .datetime({ offset: true })
            .describe("Start datetime (ISO 8601)"),
        end: z
            .string()
            .datetime({ offset: true })
            .describe("End datetime (ISO 8601)"),
        wholeDay: z.boolean().optional().describe("Create as a whole-day event"),
        calendarUrl: z.string(),
        description: z.string().optional(),
        location: z.string().optional(),
        recurrenceRule: recurrenceRuleSchema.optional(),
    },
    returns: "The unique ID of the created event",
};
export function registerCreateEvent(client, server) {
    server.registerTool(createEventDefinition.name, {
        description: createEventDefinition.description,
        inputSchema: createEventDefinition.inputSchema,
    }, async (args) => {
        const { calendarUrl, summary, start, end, wholeDay, description, location, recurrenceRule, } = args;
        // The object is written here rather than by ts-caldav: it reads a
        // whole-day date in UTC (an appointment on 3 October lands on the 2nd
        // east of Greenwich) and writes a repetition rule's end date in a
        // notation no calendar can read afterwards.
        const uid = randomUUID();
        await createObject(client, calendarUrl, uid, buildEvent({
            uid, summary, start, end, wholeDay,
            ...(description !== undefined && { description }),
            ...(location !== undefined && { location }),
            ...(recurrenceRule !== undefined && { recurrenceRule }),
        }));
        return {
            content: [{ type: "text", text: uid }],
        };
    });
}
