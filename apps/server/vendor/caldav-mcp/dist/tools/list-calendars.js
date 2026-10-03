export const listCalendarsDefinition = {
    name: "list-calendars",
    description: "List all calendars returning both name and URL. With more than one NAS configured, every calendar also names its NAS and its URL starts with the number of that NAS (\"2:/...\"); pass the URL on to the other tools exactly as listed.",
    inputSchema: {},
    returns: "List of all available calendars",
};
export async function registerListCalendars(client, server) {
    server.registerTool(listCalendarsDefinition.name, {
        description: listCalendarsDefinition.description,
        inputSchema: listCalendarsDefinition.inputSchema,
    }, async () => {
        // Fetched per call rather than once at registration: registration must
        // not touch the network (see dist/index.js), and a calendar
        // added on the NAS now shows up without restarting Claude Desktop.
        const calendars = await client.getCalendars();
        return { content: [{ type: "text", text: JSON.stringify(calendars) }] };
    });
}
