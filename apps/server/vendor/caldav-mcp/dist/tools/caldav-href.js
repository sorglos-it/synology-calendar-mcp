/**
 * Builds the CalDAV object href (`<calendar>/<uid>.ics`) used to address a
 * single event or todo. Mirrors how ts-caldav stores objects, tolerating a
 * calendar URL with or without a trailing slash.
 *
 * The uid lands in the URL path unencoded - here and in ts-caldav's own
 * delete - and uids are chosen by whoever created the event. "../work/x"
 * would address an object in another calendar, "#" or "?" the calendar
 * itself. Every tool that takes a uid calls this before it changes anything,
 * so a uid with such characters is refused here.
 */
export function hrefFor(calendarUrl, uid) {
    if (!uid || /[/\\?#%\x00-\x1f\x7f]/.test(uid)) {
        throw new Error(`Refused uid ${JSON.stringify(uid)}: it must not contain / \\ ? # % or control characters.`);
    }
    const base = calendarUrl.endsWith("/") ? calendarUrl : `${calendarUrl}/`;
    return `${base}${uid}.ics`;
}