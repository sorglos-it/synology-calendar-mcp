export const listCalendarsDefinition = {
    name: "list-calendars",
    description: "List all calendars returning both name and URL",
    inputSchema: {},
    returns: "List of all available calendars",
};
export async function registerListCalendars(client, server) {
    server.registerTool(listCalendarsDefinition.name, {
        description: listCalendarsDefinition.description,
        inputSchema: listCalendarsDefinition.inputSchema,
    }, async () => {
        // Fetched per call rather than once at registration: registration must
        // not touch the network (see server/dist/index.js), and a calendar
        // added on the NAS now shows up without restarting Claude Desktop.
        const calendars = await client.getCalendars();
        return { content: [{ type: "text", text: JSON.stringify(calendars) }] };
    });
}
