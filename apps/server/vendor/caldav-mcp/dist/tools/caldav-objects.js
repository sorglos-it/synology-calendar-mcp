/**
 * Fetching and writing whole calendar objects - our own file, not part of
 * caldav-mcp (see THIRD-PARTY.md).
 *
 * ts-caldav hands out a simplified model of an event or task; the tools that
 * change one need the object as the server stores it, so they ask for the
 * calendar data itself. Both requests go through the client of the wrapper in
 * ../index.js, which keeps them on the NAS.
 */
import { XMLParser } from "fast-xml-parser";
import { hrefFor } from "./caldav-href.js";
import { uidOf } from "./caldav-ical.js";

const parser = new XMLParser({ removeNSPrefix: true });
const PROPS = "<d:prop><d:getetag/><c:calendar-data/></d:prop>";
const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';

/** 2026-09-20T00:00:00Z as CalDAV wants it: 20260920T000000Z */
export const stampOf = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** The objects of one calendar, as {href, etag, ics}. */
export function parseMultistatus(xml) {
	const data = typeof xml === "string" ? parser.parse(xml) : xml;
	let responses = data?.multistatus?.response ?? [];
	if (!Array.isArray(responses)) responses = [responses];
	const out = [];
	for (const response of responses) {
		let propstats = response?.propstat ?? [];
		if (!Array.isArray(propstats)) propstats = [propstats];
		for (const propstat of propstats) {
			const ics = propstat?.prop?.["calendar-data"];
			if (ics === undefined || ics === null || ics === "") continue;
			out.push({
				href: String(response.href ?? ""),
				// &#13; survives some servers' escaping and would break parsing
				ics: String(ics).replace(/&#13;/g, "\r"),
				etag: propstat.prop.getetag ? String(propstat.prop.getetag) : "",
			});
		}
	}
	return out;
}

/** Every VEVENT/VTODO object of a calendar, optionally limited to a period. */
export async function queryObjects(client, calendarUrl, component, range) {
	const filter = range
		? `<c:comp-filter name="${component}"><c:time-range start="${stampOf(range.start)}" end="${stampOf(range.end)}"/></c:comp-filter>`
		: `<c:comp-filter name="${component}"/>`;
	const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS}>${PROPS}`
		+ `<c:filter><c:comp-filter name="VCALENDAR">${filter}</c:comp-filter></c:filter></c:calendar-query>`;
	return parseMultistatus(await client.report(calendarUrl, body, "1"));
}

/** One object by its address. */
export async function readObject(client, calendarUrl, href) {
	const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget ${NS}>${PROPS}`
		+ `<d:href>${href}</d:href></c:calendar-multiget>`;
	const [found] = parseMultistatus(await client.report(calendarUrl, body, "1"));
	return found ?? null;
}

/**
 * The object with this uid. Nearly always <calendar>/<uid>.ics, which is one
 * request; an object stored under another name is looked for in the calendar
 * rather than reported as missing.
 */
export async function findObject(client, calendarUrl, component, uid) {
	const direct = await readObject(client, calendarUrl, hrefFor(calendarUrl, uid));
	if (direct && uidOf(direct.ics) === uid) return direct;
	for (const object of await queryObjects(client, calendarUrl, component, null)) {
		if (uidOf(object.ics) === uid) return object;
	}
	return null;
}

/** Writes an object back, refusing if it changed on the server meanwhile. */
export async function writeObject(client, object, ics) {
	const etag = String(object.etag || "");
	const headers = etag && !etag.startsWith("W/") ? { "If-Match": etag } : {};
	await client.mkIcsPut(object.href, ics, headers);
}
