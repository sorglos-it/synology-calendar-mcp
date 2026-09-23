/**
 * Reading and changing iCalendar objects in place - our own file, not part of
 * caldav-mcp (see THIRD-PARTY.md).
 *
 * The update tools used to hand ts-caldav's simplified model back to it, and it
 * rebuilt the whole object from the handful of fields that model has. Renaming
 * one appointment therefore threw away everything else the object carried: a
 * moved instance of a series (RECURRENCE-ID), a cancelled date (EXDATE), the
 * attendees and their answers, the time zone, a task's repetition rule, its
 * categories - and a date turned into a timestamp, which moves a whole-day
 * appointment by a day in every time zone east of Greenwich.
 *
 * Everything here edits the object the server sent and leaves every other line
 * of it untouched.
 */
import ICAL from "ical.js";

/** The text of a VCALENDAR as a component tree. */
export function parseCalendar(text) {
	const cal = new ICAL.Component(ICAL.parse(text));
	if (cal.name !== "vcalendar") {
		throw new Error("The server did not return an iCalendar object.");
	}
	return cal;
}

export function uidOf(text) {
	for (const name of ["vevent", "vtodo"]) {
		const comp = parseCalendar(text).getFirstSubcomponent(name);
		const uid = comp?.getFirstPropertyValue("uid");
		if (uid) return String(uid);
	}
	return "";
}

/**
 * The component a change applies to: the one without RECURRENCE-ID. The others
 * are moved or changed single instances of a series and stay as they are.
 */
function mainComponent(cal, name) {
	const all = cal.getAllSubcomponents(name);
	const main = all.find((c) => !c.getFirstProperty("recurrence-id"));
	if (!main && all.length === 0) {
		throw new Error(`The object holds no ${name.toUpperCase()}.`);
	}
	return main ?? all[0];
}

/** Makes the time zones defined inside the object usable for conversions. */
function useZones(cal) {
	for (const vt of cal.getAllSubcomponents("vtimezone")) {
		const tzid = String(vt.getFirstPropertyValue("tzid") || "");
		if (tzid && !ICAL.TimezoneService.has(tzid)) {
			ICAL.TimezoneService.register(tzid, new ICAL.Timezone(vt));
		}
	}
}

const dateOnly = (iso) => String(iso).slice(0, 10);
const asDate = (iso) => ICAL.Time.fromDateString(dateOnly(iso));
const asUtc = (iso) => ICAL.Time.fromJSDate(iso instanceof Date ? iso : new Date(iso), true);

function text(comp, name, value) {
	if (value === undefined) return;
	if (value === "" || value === null) comp.removeAllProperties(name);
	else comp.updatePropertyWithValue(name, value);
}

/**
 * Writes a time property, keeping the kind the object already used: a date
 * stays a date, and a timestamp stays in the time zone the object names - a
 * weekly series in Europe/Berlin must not silently become a series in UTC,
 * which would drift by an hour at the change of time.
 */
function putTime(comp, name, value) {
	comp.removeAllProperties(name);
	const prop = new ICAL.Property(name);
	prop.setValue(value);
	if (!value.isDate && value.zone && value.zone !== ICAL.Timezone.utcTimezone
		&& value.zone !== ICAL.Timezone.localTimezone) {
		prop.setParameter("tzid", value.zone.tzid);
	}
	comp.addProperty(prop);
}

const timeOf = (comp, name) => comp.getFirstPropertyValue(name) || null;

/** DTSTAMP, LAST-MODIFIED and SEQUENCE as every calendar client writes them. */
function stamp(comp) {
	const now = ICAL.Time.fromJSDate(new Date(), true);
	comp.updatePropertyWithValue("dtstamp", now);
	comp.updatePropertyWithValue("last-modified", now);
	const seq = Number(comp.getFirstPropertyValue("sequence") ?? 0);
	comp.updatePropertyWithValue("sequence", (Number.isFinite(seq) ? seq : 0) + 1);
}

function recurFromRule(rule, wholeDay) {
	const parts = [`FREQ=${rule.freq ?? "DAILY"}`];
	if (rule.interval !== undefined) parts.push(`INTERVAL=${rule.interval}`);
	if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
	if (rule.until !== undefined) {
		// a whole-day series ends on a date, not at a moment (RFC 5545 §3.3.10)
		parts.push(`UNTIL=${(wholeDay ? asDate(rule.until) : asUtc(rule.until)).toICALString()}`);
	}
	if (rule.byday?.length) parts.push(`BYDAY=${rule.byday.join(",")}`);
	if (rule.bymonthday?.length) parts.push(`BYMONTHDAY=${rule.bymonthday.join(",")}`);
	if (rule.bymonth?.length) parts.push(`BYMONTH=${rule.bymonth.join(",")}`);
	return ICAL.Recur.fromString(parts.join(";"));
}

const PRODID = "-//sorglos//synology-calendar//EN";

function newCalendar(name) {
	const cal = new ICAL.Component(["vcalendar", [], []]);
	cal.addPropertyWithValue("version", "2.0");
	cal.addPropertyWithValue("prodid", PRODID);
	const comp = new ICAL.Component(name);
	cal.addSubcomponent(comp);
	comp.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
	return [cal, comp];
}

/**
 * A new appointment as a whole object.
 *
 * Written here rather than by ts-caldav, which puts a repetition rule's end
 * date into the object in the wrong notation ("2026-11-30T23:00:00Z" instead
 * of "20261130T230000Z"). The server takes it, and from then on nothing can
 * read the appointment any more - not this extension and not the calendar app.
 */
export function buildEvent(fields) {
	const [cal, vevent] = newCalendar("vevent");
	vevent.addPropertyWithValue("uid", fields.uid);
	const whole = !!fields.wholeDay;
	const start = whole ? asDate(fields.start) : asUtc(fields.start);
	const end = whole ? asDate(fields.end) : asUtc(fields.end);
	if (whole) end.adjust(1, 0, 0, 0); // DTEND is the day after the last one
	if (end.compare(start) <= 0) {
		// an end before the start is no appointment; a day, or an hour
		const fixed = start.clone();
		fixed.adjust(whole ? 1 : 0, whole ? 0 : 1, 0, 0);
		putTime(vevent, "dtend", fixed);
	} else {
		putTime(vevent, "dtend", end);
	}
	putTime(vevent, "dtstart", start);
	text(vevent, "summary", fields.summary);
	text(vevent, "description", fields.description);
	text(vevent, "location", fields.location);
	if (fields.recurrenceRule) {
		vevent.addPropertyWithValue("rrule", recurFromRule(fields.recurrenceRule, whole));
	}
	return cal.toString();
}

/** A new task as a whole object. */
export function buildTodo(fields) {
	const [cal, vtodo] = newCalendar("vtodo");
	vtodo.addPropertyWithValue("uid", fields.uid);
	if (fields.due !== undefined) putTime(vtodo, "due", asUtc(fields.due));
	if (fields.start !== undefined) putTime(vtodo, "dtstart", asUtc(fields.start));
	text(vtodo, "summary", fields.summary);
	text(vtodo, "description", fields.description);
	text(vtodo, "location", fields.location);
	vtodo.addPropertyWithValue("status", fields.status || "NEEDS-ACTION");
	if (fields.status === "COMPLETED") {
		vtodo.addPropertyWithValue("completed", ICAL.Time.fromJSDate(new Date(), true));
		vtodo.addPropertyWithValue("percent-complete", 100);
	}
	return cal.toString();
}

/**
 * Changes only the given fields of an event and returns the whole object again.
 *
 * Dates are touched only when start, end or wholeDay is given. Moving an event
 * by giving just a start keeps its length.
 */
export function patchEvent(text_, changes) {
	const cal = parseCalendar(text_);
	useZones(cal);
	const vevent = mainComponent(cal, "vevent");
	const { summary, description, location, start, end, wholeDay, recurrenceRule } = changes;

	text(vevent, "summary", summary);
	text(vevent, "description", description);
	text(vevent, "location", location);

	const oldStart = timeOf(vevent, "dtstart");
	const oldEnd = timeOf(vevent, "dtend");
	const duration = vevent.getFirstPropertyValue("duration");
	const wasDate = oldStart ? oldStart.isDate : false;
	const toDate = wholeDay === undefined ? wasDate : wholeDay;

	if (start !== undefined || end !== undefined || wholeDay !== undefined) {
		if (!oldStart) throw new Error("The event has no start date.");
		const kindKept = toDate === wasDate;
		// A new time is written in the zone the event already used, so that a
		// weekly series keeps its local hour instead of drifting at the change
		// of time - and so that the arithmetic below stays within one zone.
		let newStart = start !== undefined
			? inZone(toDate ? asDate(start) : asUtc(start), oldStart)
			: (kindKept ? oldStart.clone() : convertKind(oldStart, toDate));
		let newEnd;
		if (end !== undefined) {
			newEnd = inZone(toDate ? asDate(end) : asUtc(end), oldEnd ?? oldStart);
			// a whole-day DTEND is the first day *after* the event
			if (toDate) newEnd.adjust(1, 0, 0, 0);
		} else if (oldEnd && kindKept) {
			// keep the length when only the start moved
			newEnd = oldEnd.clone();
			newEnd.addDuration(newStart.subtractDate(oldStart));
		} else if (duration && kindKept) {
			newEnd = null; // DURATION stays, so the event keeps its length
		} else {
			newEnd = newStart.clone();
			newEnd.adjust(toDate ? 1 : 0, toDate ? 0 : 1, 0, 0); // a day, or an hour
		}
		// The dates a series cancels or moves are written as local times of the
		// same zone: they have to travel with the start, or a cancelled date
		// comes back and a moved instance loses its place in the series.
		const moved = newStart.subtractDate(oldStart);
		if (moved.toSeconds() !== 0 && vevent.getFirstProperty("rrule")) {
			shiftSeries(cal, vevent, moved);
		}
		putTime(vevent, "dtstart", newStart);
		if (newEnd) {
			vevent.removeAllProperties("duration");
			putTime(vevent, "dtend", newEnd);
		}
	}

	if (recurrenceRule !== undefined) {
		vevent.removeAllProperties("rrule");
		if (recurrenceRule) {
			const isDate = timeOf(vevent, "dtstart")?.isDate ?? false;
			vevent.addPropertyWithValue("rrule", recurFromRule(recurrenceRule, isDate));
		}
	}
	stamp(vevent);
	return cal.toString();
}

/** The same moment, written in the zone another value uses. */
function inZone(time, like) {
	const zone = like?.zone;
	if (time.isDate || !zone || zone === ICAL.Timezone.utcTimezone
		|| zone === ICAL.Timezone.localTimezone) {
		return time;
	}
	return time.convertToZone(zone);
}

/** Moves EXDATE and the RECURRENCE-ID of every changed instance along. */
function shiftSeries(cal, master, moved) {
	for (const prop of master.getAllProperties("exdate")) {
		prop.setValues(prop.getValues().map((t) => {
			const shifted = t.clone();
			shifted.addDuration(moved);
			return shifted;
		}));
	}
	for (const other of cal.getAllSubcomponents("vevent")) {
		const rid = other === master ? null : other.getFirstProperty("recurrence-id");
		if (!rid) continue;
		const time = rid.getFirstValue().clone();
		time.addDuration(moved);
		rid.setValue(time);
	}
}

/** A time as date or as timestamp, whichever kind is asked for. */
function convertKind(time, toDate) {
	if (time.isDate === toDate) return time.clone();
	if (toDate) return ICAL.Time.fromDateString(time.toString().slice(0, 10));
	const t = time.clone();
	t.isDate = false;
	return t;
}

/**
 * Changes only the given fields of a task. STATUS and COMPLETED are kept
 * consistent: a task that becomes COMPLETED gets a completion time, a task
 * that leaves that status loses it (RFC 5545 §3.8.1.1).
 */
export function patchTodo(text_, changes) {
	const cal = parseCalendar(text_);
	useZones(cal);
	const vtodo = mainComponent(cal, "vtodo");
	const { summary, description, location, due, start, status } = changes;

	text(vtodo, "summary", summary);
	text(vtodo, "description", description);
	text(vtodo, "location", location);
	for (const [name, value] of [["due", due], ["dtstart", start]]) {
		if (value === undefined) continue;
		const old = timeOf(vtodo, name);
		// a deadline written as a date stays a date, not midnight somewhere
		putTime(vtodo, name, inZone(old?.isDate ? asDate(value) : asUtc(value), old));
	}
	if (status !== undefined) {
		vtodo.updatePropertyWithValue("status", status);
		if (status === "COMPLETED") {
			if (!vtodo.getFirstProperty("completed")) {
				vtodo.updatePropertyWithValue("completed", ICAL.Time.fromJSDate(new Date(), true));
			}
			vtodo.updatePropertyWithValue("percent-complete", 100);
		} else {
			vtodo.removeAllProperties("completed");
			vtodo.removeAllProperties("percent-complete");
		}
	}
	stamp(vtodo);
	return cal.toString();
}

const dateString = (time) => time.toString().slice(0, 10);
const utcString = (time) => time.toJSDate().toISOString();

function eventOut(item, startTime, endTime, recurrenceId) {
	const whole = startTime.isDate;
	const last = whole && endTime ? endTime.clone() : endTime;
	if (whole && last) last.adjust(-1, 0, 0, 0); // DTEND is exclusive, show the last day
	const out = {
		uid: item.uid,
		summary: item.summary || "Untitled Event",
		start: whole ? dateString(startTime) : utcString(startTime),
		end: whole ? dateString(last ?? startTime) : utcString(endTime ?? startTime),
	};
	if (item.description) out.description = item.description;
	if (item.location) out.location = item.location;
	if (whole) out.wholeDay = true;
	if (recurrenceId) {
		out.recurring = true;
		out.recurrenceId = recurrenceId.isDate ? dateString(recurrenceId) : utcString(recurrenceId);
	}
	return out;
}

/**
 * The occurrences of one object between from and to.
 *
 * A series is expanded here rather than shown as its first date: cancelled
 * dates (EXDATE) drop out, a moved instance (RECURRENCE-ID) appears at its new
 * time, and the answer says which occurrence it is.
 */
export function expandEvents(text_, from, to, limit = 500, onSkip = null) {
	const cal = parseCalendar(text_);
	useZones(cal);
	// one object can hold several appointments that have nothing to do with
	// each other; what belongs together shares a uid
	const groups = new Map();
	for (const comp of cal.getAllSubcomponents("vevent")) {
		const uid = String(comp.getFirstPropertyValue("uid") ?? "");
		groups.set(uid, [...(groups.get(uid) ?? []), comp]);
	}
	const out = [];
	for (const [uid, comps] of groups) {
		if (out.length >= limit) break;
		try {
			out.push(...expandOne(comps, from, to, limit - out.length));
		} catch (error) {
			// one damaged appointment must not cost the others in this object
			if (!onSkip) throw error;
			onSkip(uid, error);
		}
	}
	return out;
}

function expandOne(comps, from, to, limit) {
	const masters = comps.filter((c) => !c.getFirstProperty("recurrence-id"));
	const [master, ...alsoMasters] = masters;
	const changed = comps.filter((c) => !masters.includes(c));
	const single = (comp) => {
		const ev = new ICAL.Event(new ICAL.Component(comp.toJSON()));
		return eventOut(ev, ev.startDate, ev.endDate, ev.recurrenceId);
	};
	if (!master) {
		// only moved instances left in this object
		return changed.map(single).filter((o) => overlaps(o, from, to));
	}
	// The copy has no calendar around it, so ical.js does not relate the
	// instances by itself; each is offered here and strictExceptions refuses
	// one that carries a foreign uid - it must not take the place of a real
	// date of this series.
	const event = new ICAL.Event(new ICAL.Component(master.toJSON()), { strictExceptions: true });
	const zone = event.startDate?.zone;
	for (const comp of changed) {
		try {
			event.relateException(sameZoneCopy(comp, zone));
		} catch {
			// belongs to another appointment; it is listed on its own below
		}
	}
	const out = [];
	// two appointments that share a uid without being a series: each on its own
	for (const extra of alsoMasters) out.push(...expandOne([extra], from, to, limit - out.length));
	if (!event.isRecurring()) {
		const one = eventOut(event, event.startDate, event.endDate, null);
		if (overlaps(one, from, to)) out.push(one);
		return out;
	}
	const known = new Set();
	const iterator = event.iterator();
	const span = (event.duration?.toSeconds() ?? 0) * 1000;
	// A series can have started years ago and ical.js only walks it date by
	// date, so the ceiling is a safety net against an endless rule, not a
	// window: the break below ends the walk at the end of the period.
	let steps = 0;
	for (let next = iterator.next(); next; next = iterator.next()) {
		if (next.toJSDate() >= to) break;
		if (++steps > 200000) {
			throw new Error("This appointment repeats more often than can be worked out "
				+ "(200000 dates before the end of the period).");
		}
		// dates that are over before the period begins cost nothing here; one
		// moved into the period is picked up below
		if (next.toJSDate().getTime() + span <= from.getTime()) continue;
		const details = event.getOccurrenceDetails(next);
		known.add(details.recurrenceId.toJSDate().getTime());
		const one = eventOut(details.item, details.startDate, details.endDate, details.recurrenceId);
		// a moved instance can have left the period its original date is in
		if (overlaps(one, from, to)) out.push(one);
		if (out.length >= limit) return out;
	}
	// ... and one moved into the period from outside it is not on the walk
	for (const comp of changed) {
		const at = comp.getFirstPropertyValue("recurrence-id");
		if (at && known.has(at.toJSDate().getTime())) continue;
		const one = single(comp);
		if (overlaps(one, from, to) && out.length < limit) out.push(one);
	}
	return out;
}

/**
 * A copy of a changed instance whose RECURRENCE-ID is written in the zone the
 * series uses. ical.js matches instances by how that value reads, so the same
 * moment spelled as UTC beside a series in Europe/Berlin would go unnoticed -
 * and the date would then be listed twice, once as planned and once as moved.
 */
function sameZoneCopy(comp, zone) {
	const copy = new ICAL.Component(comp.toJSON());
	const prop = copy.getFirstProperty("recurrence-id");
	const value = prop?.getFirstValue();
	if (!value || value.isDate || !zone || value.zone === zone) return copy;
	const moved = value.convertToZone(zone);
	prop.setValue(moved);
	if (zone === ICAL.Timezone.utcTimezone || zone === ICAL.Timezone.localTimezone) {
		prop.removeParameter("tzid");
	} else {
		prop.setParameter("tzid", zone.tzid);
	}
	return copy;
}

function overlaps(out, from, to) {
	const start = new Date(out.wholeDay ? `${out.start}T00:00:00` : out.start);
	const end = new Date(out.wholeDay ? `${out.end}T23:59:59` : out.end);
	return start < to && end > from;
}

/** The fields of a task the list tool shows, read from the object itself. */
export function todosOf(text_) {
	const cal = parseCalendar(text_);
	useZones(cal);
	return cal.getAllSubcomponents("vtodo").map((vtodo) => {
		const value = (name) => {
			const v = vtodo.getFirstPropertyValue(name);
			return v === null || v === undefined ? undefined : v;
		};
		const time = (name) => {
			const t = timeOf(vtodo, name);
			if (!t) return {};
			// a date counts as that date, not as midnight local time - which
			// is the day before, seen from UTC, and would filter wrongly
			return t.isDate
				? { text: dateString(t), at: new Date(`${dateString(t)}T00:00:00Z`) }
				: { text: utcString(t), at: t.toJSDate() };
		};
		const due = time("due");
		const sortOrder = Number(value("x-apple-sort-order"));
		return {
			uid: String(value("uid") ?? ""),
			summary: String(value("summary") ?? "Untitled Task"),
			// a status is a keyword, whatever case the writing app used
			status: String(value("status") ?? "NEEDS-ACTION").toUpperCase(),
			due: due.text,
			dueAt: due.at ?? null,
			start: time("dtstart").text,
			completed: time("completed").text,
			description: value("description") ? String(value("description")) : undefined,
			location: value("location") ? String(value("location")) : undefined,
			sortOrder: Number.isFinite(sortOrder) ? sortOrder : undefined,
		};
	});
}
