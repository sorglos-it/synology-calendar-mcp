import { z } from "zod";
import { expandEvents } from "./caldav-ical.js";
import { queryObjects } from "./caldav-objects.js";
export const listEventsDefinition = {
    name: "list-events",
    description: "List all events between start and end date in the calendar specified by its URL",
    inputSchema: {
        start: z
            .string()
            .refine((val) => !Number.isNaN(Date.parse(val)), {
            message: "Invalid date string",
        })
            .describe("Start date (ISO 8601)"),
        end: z
            .string()
            .refine((val) => !Number.isNaN(Date.parse(val)), {
            message: "Invalid date string",
        })
            .describe("End date (ISO 8601)"),
        calendarUrl: z.string(),
    },
    returns: "A list of the appointments in that period, sorted by start, each with `uid`, `summary`, `start`, `end` and optionally `description`, `location`, `wholeDay` and, for one date of a recurring event, `recurring` with `recurrenceId`. A recurring event is listed once per date it falls on; a whole-day event carries dates (YYYY-MM-DD, `end` is its last day), everything else timestamps.",
};
export function registerListEvents(client, server) {
    server.registerTool(listEventsDefinition.name, {
        description: listEventsDefinition.description,
        inputSchema: listEventsDefinition.inputSchema,
    }, async (args) => {
        const { calendarUrl, start, end } = args;
        const from = new Date(start);
        const to = new Date(end);
        // The objects are read as the server stores them and the dates of a
        // series are worked out here: ts-caldav's model shows a weekly
        // appointment once, on the date it started, which is no answer to
        // "what is on next week".
        const objects = await queryObjects(client, calendarUrl, "VEVENT", { start: from, end: to });
        const data = [];
        const unreadable = [];
        const why = (error) => (error instanceof Error ? error.message : String(error));
        for (const object of objects) {
            // one damaged appointment must not take the whole calendar with it
            const skipped = (uid, error) => unreadable.push(`${object.href} (${uid}: ${why(error)})`);
            try {
                data.push(...expandEvents(object.ics, from, to, 500, skipped));
            }
            catch (error) {
                unreadable.push(`${object.href} (${why(error)})`);
            }
        }
        data.sort((a, b) => String(a.start).localeCompare(String(b.start)));
        const content = [{ type: "text", text: JSON.stringify(data) }];
        if (data.length >= 500) {
            content.push({
                type: "text",
                text: "Note: 500 appointments is the most this answers with; ask for a shorter period to see the rest.",
            });
        }
        if (unreadable.length > 0) {
            content.push({
                type: "text",
                text: `Note: ${unreadable.length} object(s) in this calendar could not be read and are missing from the list: ${unreadable.join("; ")}`,
            });
        }
        return { content };
    });
}
