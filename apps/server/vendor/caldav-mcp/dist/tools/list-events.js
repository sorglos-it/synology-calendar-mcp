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
        const data = objects.flatMap((object) => expandEvents(object.ics, from, to));
        data.sort((a, b) => String(a.start).localeCompare(String(b.start)));
        return {
            content: [{ type: "text", text: JSON.stringify(data) }],
        };
    });
}
