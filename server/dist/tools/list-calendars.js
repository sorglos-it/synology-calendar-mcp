export const listCalendarsDefinition = {
    name: "list-calendars",
    description: "List all calendars returning both name and URL",
    inputSchema: {},
    returns: "List of all available calendars",
};
export async function registerListCalendars(client, server) {
    const calendars = await client.getCalendars();
    server.registerTool(listCalendarsDefinition.name, {
        description: listCalendarsDefinition.description,
        inputSchema: listCalendarsDefinition.inputSchema,
    }, async () => {
        return { content: [{ type: "text", text: JSON.stringify(calendars) }] };
    });
}
