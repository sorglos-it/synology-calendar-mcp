import { z } from "zod";
function toRecurrenceRule(r) {
    const out = {};
    if (r.freq !== undefined)
        out.freq = r.freq;
    if (r.interval !== undefined)
        out.interval = r.interval;
    if (r.count !== undefined)
        out.count = r.count;
    if (r.until !== undefined)
        out.until = new Date(r.until);
    if (r.byday !== undefined)
        out.byday = r.byday;
    if (r.bymonthday !== undefined)
        out.bymonthday = r.bymonthday;
    if (r.bymonth !== undefined)
        out.bymonth = r.bymonth;
    return out;
}
const recurrenceRuleSchema = z.object({
    freq: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]).optional(),
    interval: z.number().optional(),
    count: z.number().optional(),
    until: z.string().datetime({ offset: true }).optional(), // ISO 8601 string
    byday: z.array(z.string()).optional(), // e.g. ["MO", "TU"]
    bymonthday: z.array(z.number()).optional(),
    bymonth: z.array(z.number()).optional(),
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
        // A whole-day event is written from the calendar date the caller named.
        // Through a Date it would be the UTC date of that moment instead, and
        // "2026-10-03T00:00:00+02:00" would land on 2 October.
        const day = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
        const event = await client.createEvent(calendarUrl, {
            summary: summary,
            start: wholeDay ? day(start) : new Date(start),
            end: wholeDay ? day(end) : new Date(end),
            ...(wholeDay !== undefined && { wholeDay }),
            ...(description !== undefined && { description }),
            ...(location !== undefined && { location }),
            ...(recurrenceRule !== undefined && {
                recurrenceRule: toRecurrenceRule(recurrenceRule),
            }),
        });
        return {
            content: [{ type: "text", text: event.uid }],
        };
    });
}
