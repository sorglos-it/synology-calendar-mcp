// Unit checks for the new iCalendar layer, straight against the module.
//   node test_ical.mjs
import { patchEvent, patchTodo, expandEvents, todosOf, uidOf } from
	"../vendor/caldav-mcp/dist/tools/caldav-ical.js";

let bad = 0;
const check = (name, cond, detail = "") => {
	console.log((cond ? "ok   " : "FAIL ") + name + (cond ? "" : `\n       -> ${detail}`));
	if (!cond) bad++;
};
const ics = (...lines) => lines.join("\r\n") + "\r\n";

const SERIES = ics(
	"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN",
	"BEGIN:VTIMEZONE", "TZID:Europe/Berlin",
	"BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST",
	"DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
	"BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET",
	"DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
	"END:VTIMEZONE",
	"BEGIN:VEVENT", "UID:series-1", "SUMMARY:Team",
	"DTSTART;TZID=Europe/Berlin:20260907T100000", "DTEND;TZID=Europe/Berlin:20260907T110000",
	"RRULE:FREQ=WEEKLY;COUNT=10", "EXDATE;TZID=Europe/Berlin:20260921T100000",
	"ORGANIZER;CN=Chef:mailto:chef@example.com",
	"ATTENDEE;CN=Anna;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:anna@example.com",
	"SEQUENCE:2", "DTSTAMP:20260901T080000Z", "END:VEVENT",
	"BEGIN:VEVENT", "UID:series-1", "RECURRENCE-ID;TZID=Europe/Berlin:20260928T100000",
	"SUMMARY:Team (verschoben)", "DTSTART;TZID=Europe/Berlin:20260928T140000",
	"DTEND;TZID=Europe/Berlin:20260928T150000", "DTSTAMP:20260901T080000Z", "END:VEVENT",
	"END:VCALENDAR");

const ALLDAY = ics("BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:allday-1",
	"SUMMARY:Urlaub", "DTSTART;VALUE=DATE:20260922", "DTEND;VALUE=DATE:20260923",
	"DTSTAMP:20260901T080000Z", "END:VEVENT", "END:VCALENDAR");

const PLAIN = ics("BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:plain-1",
	"SUMMARY:Arzt", "DTSTART:20260924T090000Z", "DTEND:20260924T100000Z",
	"DTSTAMP:20260901T080000Z", "END:VEVENT", "END:VCALENDAR");

const TODO = ics("BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTODO", "UID:todo-1",
	"SUMMARY:Müll rausbringen", "RRULE:FREQ=WEEKLY", "DUE;VALUE=DATE:20260925",
	"CATEGORIES:Haus,Garten", "STATUS:NEEDS-ACTION", "X-APPLE-SORT-ORDER:12",
	"DTSTAMP:20260901T080000Z", "END:VTODO", "END:VCALENDAR");

// --- renaming a series keeps everything else
let out = patchEvent(SERIES, { summary: "Neuer Titel" });
check("series: summary changed", out.includes("SUMMARY:Neuer Titel"), out);
check("series: moved instance kept", out.includes("RECURRENCE-ID;TZID=Europe/Berlin:20260928T100000")
	&& out.includes("SUMMARY:Team (verschoben)"), out);
check("series: cancelled date kept", out.includes("EXDATE;TZID=Europe/Berlin:20260921T100000"), out);
check("series: attendee with parameters kept",
	/ATTENDEE;CN=Anna;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:anna@example.com/.test(out), out);
check("series: organizer kept", out.includes("ORGANIZER;CN=Chef:mailto:chef@example.com"), out);
check("series: time zone kept", out.includes("BEGIN:VTIMEZONE") && out.includes("TZID:Europe/Berlin"), out);
check("series: start untouched", out.includes("DTSTART;TZID=Europe/Berlin:20260907T100000")
	&& !/DTSTART[^\r\n]*Z\r?\n/.test(out), out);
check("series: rule kept", out.includes("RRULE:FREQ=WEEKLY;COUNT=10"), out);
check("series: sequence raised", /SEQUENCE:3/.test(out), out);

// --- moving the series start keeps the time zone and the length
out = patchEvent(SERIES, { start: "2026-09-07T09:00:00+02:00" });
check("series: moved start stays in its time zone",
	out.includes("DTSTART;TZID=Europe/Berlin:20260907T090000"), out);
check("series: length kept", out.includes("DTEND;TZID=Europe/Berlin:20260907T100000"), out);

// --- whole-day events keep their dates
out = patchEvent(ALLDAY, { summary: "Ferien" });
check("whole day: dates untouched", out.includes("DTSTART;VALUE=DATE:20260922")
	&& out.includes("DTEND;VALUE=DATE:20260923"), out);
out = patchEvent(ALLDAY, { start: "2026-10-03T00:00:00+02:00", end: "2026-10-05T00:00:00+02:00" });
check("whole day: new dates, end exclusive", out.includes("DTSTART;VALUE=DATE:20261003")
	&& out.includes("DTEND;VALUE=DATE:20261006"), out);

// --- timed events
out = patchEvent(PLAIN, { start: "2026-09-24T11:00:00+02:00", end: "2026-09-24T12:00:00+02:00" });
check("timed: written as UTC", out.includes("DTSTART:20260924T090000Z")
	&& out.includes("DTEND:20260924T100000Z"), out);
out = patchEvent(PLAIN, { start: "2026-09-24T11:00:00Z" });
check("timed: only start given keeps the hour length",
	out.includes("DTSTART:20260924T110000Z") && out.includes("DTEND:20260924T120000Z"), out);

// --- tasks
out = patchTodo(TODO, { status: "COMPLETED" });
check("todo: rule kept", out.includes("RRULE:FREQ=WEEKLY"), out);
check("todo: date-only due kept", out.includes("DUE;VALUE=DATE:20260925"), out);
check("todo: categories kept", out.includes("CATEGORIES:Haus,Garten"), out);
check("todo: status and completion time", out.includes("STATUS:COMPLETED")
	&& /COMPLETED:\d{8}T\d{6}Z/.test(out), out);
check("todo: no garbage properties", !/^\d+=/m.test(out), out);
out = patchTodo(patchTodo(TODO, { status: "COMPLETED" }), { status: "NEEDS-ACTION" });
check("todo: reopening drops the completion time", !out.includes("COMPLETED:"), out);
out = patchTodo(TODO, { summary: "Neu" });
check("todo: rename keeps the rest", out.includes("SUMMARY:Neu") && out.includes("RRULE:FREQ=WEEKLY")
	&& out.includes("DUE;VALUE=DATE:20260925") && out.includes("CATEGORIES:Haus,Garten"), out);

// --- listing
const from = new Date("2026-09-01T00:00:00Z"), to = new Date("2026-10-05T23:00:00Z");
const list = expandEvents(SERIES, from, to);
const starts = list.map((e) => e.start);
check("list: series expanded per date", list.length === 4, starts);
check("list: cancelled date missing", !starts.some((s) => s.startsWith("2026-09-21")), starts);
check("list: moved instance at its new time",
	starts.includes("2026-09-28T12:00:00.000Z"), starts);
check("list: moved instance keeps its own summary",
	list.find((e) => e.start.startsWith("2026-09-28"))?.summary === "Team (verschoben)", list);
check("list: ordinary dates at 10:00 Berlin",
	starts.includes("2026-09-07T08:00:00.000Z") && starts.includes("2026-09-14T08:00:00.000Z")
	&& starts.includes("2026-10-05T08:00:00.000Z"), starts);
check("list: window edges", expandEvents(SERIES, new Date("2026-09-20T00:00:00Z"),
	new Date("2026-10-05T00:00:00Z")).map((e) => e.start).join() === "2026-09-28T12:00:00.000Z",
	expandEvents(SERIES, new Date("2026-09-20T00:00:00Z"), new Date("2026-10-05T00:00:00Z")));
check("list: every instance marked as recurring",
	list.every((e) => e.recurring === true && typeof e.recurrenceId === "string"), list);
const allday = expandEvents(ALLDAY, from, to);
check("list: whole day as dates, end inclusive", allday.length === 1
	&& allday[0].start === "2026-09-22" && allday[0].end === "2026-09-22"
	&& allday[0].wholeDay === true, allday);
const plain = expandEvents(PLAIN, from, to);
check("list: single event without extra keys", plain.length === 1 && !("recurring" in plain[0])
	&& !("wholeDay" in plain[0]) && plain[0].start === "2026-09-24T09:00:00.000Z", plain);
check("list: outside the window stays out", expandEvents(PLAIN, new Date("2026-10-01T00:00:00Z"), to).length === 0);

// --- a series that started years ago
const OLD = ics("BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:old-1", "SUMMARY:Täglich",
	"DTSTART:20130101T060000Z", "DTEND:20130101T063000Z", "RRULE:FREQ=DAILY",
	"DTSTAMP:20130101T060000Z", "END:VEVENT", "END:VCALENDAR");
const week = expandEvents(OLD, new Date("2026-09-20T00:00:00Z"), new Date("2026-09-27T00:00:00Z"));
check("long series: dates found after 13 years", week.length === 7, week.map((e) => e.start));
const HOURLY = OLD.replace("FREQ=DAILY", "FREQ=HOURLY").replace("UID:old-1", "UID:old-2");
const hours = expandEvents(HOURLY, new Date("2026-09-20T00:00:00Z"), new Date("2026-09-20T06:00:00Z"));
check("long series: hourly since 2013 still answers", hours.length === 6, hours.length);

// --- instances that moved out of or into the period
const MOVED_OUT = SERIES.replace("DTSTART;TZID=Europe/Berlin:20260928T140000", "DTSTART;TZID=Europe/Berlin:20261015T140000")
	.replace("DTEND;TZID=Europe/Berlin:20260928T150000", "DTEND;TZID=Europe/Berlin:20261015T150000");
let moved = expandEvents(MOVED_OUT, new Date("2026-09-20T00:00:00Z"), new Date("2026-10-05T00:00:00Z"));
check("moved out of the period: not listed there", moved.length === 0, moved);
moved = expandEvents(MOVED_OUT, new Date("2026-10-13T00:00:00Z"), new Date("2026-10-18T00:00:00Z"));
check("moved into a later period: listed there",
	moved.length === 1 && moved[0].start === "2026-10-15T12:00:00.000Z", moved);

// --- whole-day series: UNTIL is a date
out = patchEvent(ALLDAY, { recurrenceRule: { freq: "WEEKLY", until: "2026-12-31T00:00:00+01:00" } });
check("whole-day series: UNTIL without a time", /RRULE:FREQ=WEEKLY;UNTIL=20261231\b/.test(out)
	&& !/UNTIL=\d{8}T/.test(out), out);
out = patchEvent(PLAIN, { recurrenceRule: { freq: "WEEKLY", until: "2026-12-31T00:00:00Z" } });
check("timed series: UNTIL with a time", /UNTIL=20261231T000000Z/.test(out), out);

// --- one object, two unrelated appointments
const TWO = ics("BEGIN:VCALENDAR", "VERSION:2.0",
	"BEGIN:VEVENT", "UID:a-1", "SUMMARY:Eins", "DTSTART:20260924T080000Z", "DTEND:20260924T090000Z",
	"DTSTAMP:20260901T080000Z", "END:VEVENT",
	"BEGIN:VEVENT", "UID:b-1", "SUMMARY:Zwei", "DTSTART:20260924T100000Z", "DTEND:20260924T110000Z",
	"DTSTAMP:20260901T080000Z", "END:VEVENT", "END:VCALENDAR");
const two = expandEvents(TWO, from, to);
check("two appointments in one object: both listed",
	two.length === 2 && two.map((e) => e.summary).sort().join() === "Eins,Zwei", two);

// --- an instance with a foreign uid does not replace a real date
const FOREIGN = SERIES.replace("UID:series-1\r\nRECURRENCE-ID", "UID:fremd-1\r\nRECURRENCE-ID");
const foreign = expandEvents(FOREIGN, from, to);
check("foreign instance does not swallow the real date",
	foreign.filter((e) => e.start.startsWith("2026-09-28")).some((e) => e.summary === "Team"), foreign);

// --- an instance written in another zone than the series
const UTC_RID = SERIES.replace("RECURRENCE-ID;TZID=Europe/Berlin:20260928T100000",
	"RECURRENCE-ID:20260928T080000Z");
let mixed = expandEvents(UTC_RID, from, to);
check("instance in UTC beside a series in Berlin: listed once",
	mixed.filter((e) => e.start.startsWith("2026-09-28")).length === 1
	&& mixed.find((e) => e.start.startsWith("2026-09-28"))?.start === "2026-09-28T12:00:00.000Z",
	mixed.filter((e) => e.start.startsWith("2026-09-28")));
const UTC_SERIES = ics("BEGIN:VCALENDAR", "VERSION:2.0",
	"BEGIN:VEVENT", "UID:u-1", "SUMMARY:UTC-Serie", "DTSTART:20260907T080000Z", "DTEND:20260907T090000Z",
	"RRULE:FREQ=WEEKLY;COUNT=5", "DTSTAMP:20260901T080000Z", "END:VEVENT",
	"BEGIN:VEVENT", "UID:u-1", "RECURRENCE-ID;TZID=Europe/Berlin:20260928T100000",
	"SUMMARY:verschoben", "DTSTART:20260928T120000Z", "DTEND:20260928T130000Z",
	"DTSTAMP:20260901T080000Z", "END:VEVENT", "END:VCALENDAR");
mixed = expandEvents(UTC_SERIES, from, to);
check("instance in Berlin beside a series in UTC: listed once",
	mixed.filter((e) => e.start.startsWith("2026-09-28")).length === 1
	&& mixed.find((e) => e.start.startsWith("2026-09-28"))?.summary === "verschoben", mixed);

// --- two appointments with the same uid, neither an instance of the other
const SAME_UID = ics("BEGIN:VCALENDAR", "VERSION:2.0",
	"BEGIN:VEVENT", "UID:same-1", "SUMMARY:Eins", "DTSTART:20260924T080000Z", "DTEND:20260924T090000Z",
	"DTSTAMP:20260901T080000Z", "END:VEVENT",
	"BEGIN:VEVENT", "UID:same-1", "SUMMARY:Zwei", "DTSTART:20260925T080000Z", "DTEND:20260925T090000Z",
	"DTSTAMP:20260901T080000Z", "END:VEVENT", "END:VCALENDAR");
check("same uid, no instance: both listed",
	expandEvents(SAME_UID, from, to).map((e) => e.summary).sort().join() === "Eins,Zwei",
	expandEvents(SAME_UID, from, to));

// --- a damaged appointment costs only itself
const HALF = ics("BEGIN:VCALENDAR", "VERSION:2.0",
	"BEGIN:VEVENT", "UID:gut-1", "SUMMARY:Gut", "DTSTART:20260924T080000Z", "DTEND:20260924T090000Z",
	"DTSTAMP:20260901T080000Z", "END:VEVENT",
	"BEGIN:VEVENT", "UID:kaputt-1", "SUMMARY:Ohne Start", "DTSTAMP:20260901T080000Z", "END:VEVENT",
	"END:VCALENDAR");
const skipped = [];
const half = expandEvents(HALF, from, to, 500, (uid, error) => skipped.push(uid));
check("damaged appointment skipped, the good one kept",
	half.length === 1 && half[0].summary === "Gut" && skipped.join() === "kaputt-1", [half, skipped]);

// --- a rule that never ends is refused instead of running forever
let ceiling = "";
try {
	expandEvents(ics("BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:viel-1", "SUMMARY:Jede Minute",
		"DTSTART:20200101T000000Z", "DTEND:20200101T000100Z", "RRULE:FREQ=MINUTELY",
		"DTSTAMP:20200101T000000Z", "END:VEVENT", "END:VCALENDAR"), from, to);
} catch (e) {
	ceiling = e.message;
}
check("a rule with too many dates says so", ceiling.includes("repeats more often"), ceiling);

// --- a damaged object is refused, so the list tool can skip it
let threw = false;
try {
	expandEvents(ics("BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:kaputt",
		"SUMMARY:Ohne Start", "DTSTAMP:20260901T080000Z", "END:VEVENT", "END:VCALENDAR"), from, to);
} catch {
	threw = true;
}
check("event without a start is refused, not guessed", threw);

// --- a whole-day event falls in the same period everywhere on earth
const window = (tz) => {
	const before = process.env.TZ;
	process.env.TZ = tz;
	const n = expandEvents(ALLDAY, new Date("2026-09-21T00:00:00Z"),
		new Date("2026-09-22T00:00:00Z")).length
		+ expandEvents(ALLDAY, new Date("2026-09-23T00:00:00Z"),
			new Date("2026-09-24T00:00:00Z")).length;
	process.env.TZ = before;
	return n;
};
check("whole day: the same answer in every time zone",
	window("UTC") === 0 && window("EST5EDT") === 0 && window("Australia/Sydney") === 0,
	[window("UTC"), window("EST5EDT"), window("Australia/Sydney")]);
check("whole day: found in its own day", expandEvents(ALLDAY,
	new Date("2026-09-22T00:00:00Z"), new Date("2026-09-23T00:00:00Z")).length === 1);

// --- a repetition ends after a count or on a date, never both
let refused = "";
try {
	patchEvent(PLAIN, { recurrenceRule: { freq: "WEEKLY", count: 5, until: "2026-12-31T23:00:00Z" } });
} catch (e) {
	refused = e.message;
}
check("count and until together are refused", refused.includes("not both"), refused);

// --- a carriage return stays inside the value
out = patchEvent(PLAIN, { summary: "a\rb", description: "c\r\nd" });
check("no stray carriage return in the file",
	!/\r(?!\n)/.test(out) && out.includes("SUMMARY:a\\nb") && out.includes("DESCRIPTION:c\\nd"),
	JSON.stringify(out.split("\r\n").filter((l) => l.startsWith("SUMMARY") || l.startsWith("DESCRIPTION"))));

// --- both ends of an appointment in the same kind and zone
const FLOATING = ics("BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:float-1",
	"SUMMARY:Ohne Zone", "DTSTART:20260924T090000", "DTEND:20260924T100000",
	"DTSTAMP:20260901T080000Z", "END:VEVENT", "END:VCALENDAR");
out = patchEvent(FLOATING, { start: "2026-09-24T11:00:00Z" });
const ends = out.split("\r\n").filter((l) => l.startsWith("DTSTART") || l.startsWith("DTEND"));
check("start and end keep the same kind", ends.every((l) => l.endsWith("Z"))
	|| ends.every((l) => !l.endsWith("Z")), ends);
refused = "";
try {
	patchEvent(ALLDAY, { wholeDay: false });
} catch (e) {
	refused = e.message;
}
check("turning a whole-day event into a timed one needs times", refused.includes("needs a"), refused);

// --- tasks as the list tool sees them
const [t] = todosOf(TODO);
check("todos: date-only due stays a date", t.due === "2026-09-25" && t.dueAt instanceof Date, t);
check("todos: fields", t.uid === "todo-1" && t.status === "NEEDS-ACTION" && t.sortOrder === 12, t);
check("uidOf", uidOf(SERIES) === "series-1" && uidOf(TODO) === "todo-1");

console.log(bad ? `\nFAILED ${bad}` : "\nall passed");
process.exit(bad ? 1 : 0);
