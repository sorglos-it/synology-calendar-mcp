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
	// the key has to be there; its value is empty for a calendar with nothing
	// in the period, and that is an empty list, not a broken answer
	if (!data || typeof data !== "object" || !("multistatus" in data)) {
		// DSM answers an ended session with its login page and HTTP 200;
		// read as "the calendar is empty", that would be a lie
		throw new Error("The NAS did not answer with a calendar listing. The DSM session may "
			+ "have ended - open DSM once, then try again.");
	}
	let responses = data.multistatus?.response ?? [];
	if (!Array.isArray(responses)) responses = [responses];
	const out = [];
	for (const response of responses) {
		let propstats = response?.propstat ?? [];
		if (!Array.isArray(propstats)) propstats = [propstats];
		for (const propstat of propstats) {
			// only what the server marked as found: a 404 or 403 block carries
			// empty properties, not an object. The code is the field after the
			// protocol - a reason phrase reading "500 Error at line 204" must
			// not pass for one.
			const status = String(propstat?.status ?? "HTTP/1.1 200 OK");
			if (!/^\s*HTTP\/\d(?:\.\d)?\s+2\d\d\b/.test(status)) continue;
			const ics = propstat?.prop?.["calendar-data"];
			if (ics === undefined || ics === null || ics === "") continue;
			const etag = propstat.prop.getetag;
			out.push({
				href: String(response.href ?? ""),
				// &#13; survives some servers' escaping and would break parsing
				ics: String(ics).replace(/&#13;/g, "\r"),
				// an ETag of "0" is a version mark like any other; only a
				// missing one is none
				etag: etag === undefined || etag === null ? "" : String(etag),
			});
		}
	}
	return out;
}

/**
 * Every VEVENT/VTODO object of a calendar, optionally limited to a period or
 * to one uid. Filtering by uid keeps a single lookup from pulling the whole
 * calendar; a server that ignores the filter simply answers with more.
 */
export async function queryObjects(client, calendarUrl, component, range, uid = null) {
	const inner = uid
		? `<c:prop-filter name="UID"><c:text-match collation="i;octet">${xml(uid)}</c:text-match></c:prop-filter>`
		: range
			? `<c:time-range start="${stampOf(range.start)}" end="${stampOf(range.end)}"/>`
			: "";
	const filter = inner
		? `<c:comp-filter name="${component}">${inner}</c:comp-filter>`
		: `<c:comp-filter name="${component}"/>`;
	const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query ${NS}>${PROPS}`
		+ `<c:filter><c:comp-filter name="VCALENDAR">${filter}</c:comp-filter></c:filter></c:calendar-query>`;
	return parseMultistatus(await client.report(calendarUrl, body, "1"));
}

/** Text that goes into the request, with the five XML characters escaped. */
const xml = (value) => String(value)
	.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
	.replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** One object by its address. */
export async function readObject(client, calendarUrl, href) {
	const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-multiget ${NS}>${PROPS}`
		+ `<d:href>${xml(href)}</d:href></c:calendar-multiget>`;
	const [found] = parseMultistatus(await client.report(calendarUrl, body, "1"));
	return found ?? null;
}

/**
 * The object with this uid. Nearly always <calendar>/<uid>.ics, which is one
 * request; an object stored under another name is looked for in the calendar
 * rather than reported as missing.
 */
export async function findObject(client, calendarUrl, component, uid) {
	let href = null;
	try {
		href = hrefFor(calendarUrl, uid);
	} catch {
		// A uid that cannot be part of an address is still a uid an object may
		// carry - the calendar app names its files as it likes. It is looked
		// up below instead of being refused; nothing is built from it.
		href = null;
	}
	if (href) {
		const direct = await readObject(client, calendarUrl, href);
		if (direct && idOf(direct) === uid) return direct;
	}
	// ask for this one uid rather than pulling the whole calendar
	let found = null;
	try {
		found = (await queryObjects(client, calendarUrl, component, null, uid))
			.find((object) => idOf(object) === uid);
	} catch {
		found = null; // a server that does not understand the filter
	}
	if (found) return found;
	const all = await queryObjects(client, calendarUrl, component, null);
	return all.find((object) => idOf(object) === uid) ?? null;
}

/** The uid of an object, or nothing at all if it cannot be read. */
function idOf(object) {
	try {
		return uidOf(object.ics);
	}
	catch {
		return "";
	}
}

/** Says which object is at fault when it cannot be read or changed. */
export function damaged(uid, change) {
	try {
		return change();
	}
	catch (error) {
		throw new Error(`${uid} cannot be changed: ${error instanceof Error ? error.message : error}. `
			+ "The entry on the NAS is damaged; open it in the Synology Calendar app.");
	}
}

/**
 * What may go into If-Match: a weak validator is not allowed there, and
 * without one at all the most that can be said is that the object has to
 * still exist - better than overwriting whatever is there now.
 */
const ifMatch = (etag) => {
	const value = String(etag || "").trim();
	return value && !value.toUpperCase().startsWith("W/") ? value : "*";
};

/**
 * A write is only done when the answer says so. A CalDAV server confirms one
 * with no body at all or with XML, so two other answers give it away - both
 * of which DSM sends under HTTP 200, where they would pass for success:
 * the login page once the session has ended, and its own web API's
 * {"success":false} for everything else.
 */
function confirmWrite(response, href) {
	const type = String(response?.headers?.["content-type"] ?? "").toLowerCase();
	const data = response?.data;
	const body = typeof data === "string" ? data.trimStart().slice(0, 9).toLowerCase() : "";
	const page = type.includes("html") || body.startsWith("<html") || body.startsWith("<!doctype");
	// axios hands a JSON answer over already parsed, so an object is one too
	const report = type.includes("json") || body.startsWith("{") || body.startsWith("[")
		|| (data !== null && typeof data === "object");
	if (page || report) {
		throw new Error(`${href} was answered with ${page ? "a web page" : "a status message"} `
			+ "instead of a confirmation, so nothing was written. The DSM session may have ended - "
			+ "open DSM once, then try again.");
	}
	return response;
}

/** Writes an object back, refusing if it changed on the server meanwhile. */
export async function writeObject(client, object, ics) {
	confirmWrite(await client.mkIcsPut(object.href, ics, { "If-Match": ifMatch(object.etag) }),
		object.href);
}

/** Creates a new object; the server refuses if that address is taken. */
export async function createObject(client, calendarUrl, uid, ics) {
	const href = hrefFor(calendarUrl, uid);
	confirmWrite(await client.mkIcsPut(href, ics, { "If-None-Match": "*" }), href);
	return href;
}

/**
 * Deletes the object at its own address, whatever it is called.
 *
 * A server that carried the delete out answers 204, or 202 when it will do it
 * in a moment - DSM, measured against its own calendar, answers 204. It uses
 * 200 for the answers that are not a confirmation at all: the login page once
 * the session has ended, and its own web API's status messages. Their body
 * gives them away, and the status code is looked at on top of that, so an
 * empty 200 from something sitting in between does not read as "deleted"
 * either.
 */
export async function deleteObject(client, object) {
	const answer = confirmWrite(await client.deleteHref(object.href, ifMatch(object.etag)), object.href);
	if (answer?.status !== 202 && answer?.status !== 204) {
		throw new Error(`${object.href} was answered with ${answer?.status} instead of a confirmation, `
			+ "so nothing was deleted. The DSM session may have ended - open DSM once, then try again.");
	}
}
