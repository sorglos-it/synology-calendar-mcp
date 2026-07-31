#!/usr/bin/env node
/**
 * Entry point of the Synology Calendar desktop extension.
 *
 * Thin wrapper around the bundled caldav-mcp server (server/dist/index.js).
 * It does two things the bundled server cannot:
 *
 *   1. Claude Desktop can only inject strings into env, while Node expects the
 *      literal "0" in NODE_TLS_REJECT_UNAUTHORIZED to accept a self-signed
 *      certificate. So CALDAV_VERIFY_SSL is translated here - same name and
 *      same polarity as CARDDAV_VERIFY_SSL in the contacts extension.
 *   2. The settings dialog asks for a host name and a protocol switch, not a
 *      URL. CALDAV_BASE_URL is assembled from those before caldav-mcp reads it.
 *
 * Unlike CardDAV, ts-caldav discovers the DAV path itself, so the calendar URL
 * is the bare origin - no path appended.
 */

const flag = (name, fallback) => {
	// Blank counts as unset: Claude Desktop injects an empty string for a
	// switch it has no value for, and reading that as "off" would flip the
	// protocol behind the user's back.
	const v = String(process.env[name] ?? "").trim().toLowerCase();
	if (v === "") return fallback;
	return !["0", "false", "no", "off"].includes(v);
};

const DEFAULT_PORT = { true: 5001, false: 5000 }; // DSM https / http

/**
 * Build the CalDAV origin from a bare host name.
 *
 * People paste whole URLs into any field that looks like it wants one, so a
 * pasted scheme, path or query is stripped rather than rejected: the protocol
 * switch decides the scheme, only an explicit :port survives.
 */
const composeBaseUrl = (host, https) => {
	let h = String(host).trim().replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
	h = h.split("/")[0].split("?")[0].trim().replace(/^\.+|\.+$/g, "");
	if (h.includes("@")) h = h.slice(h.lastIndexOf("@") + 1);
	if (!h) return "";
	// after the last "]" so an IPv6 literal like [::1] is not read as host:port
	if (!h.slice(h.lastIndexOf("]") + 1).includes(":")) {
		h = `${h}:${DEFAULT_PORT[https]}`;
	}
	return `${https ? "https" : "http"}://${h}`;
};

if (!flag("CALDAV_VERIFY_SSL", true)) {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

// CALDAV_BASE_URL stays supported for existing setups and wins when both are set.
if (!process.env.CALDAV_BASE_URL && process.env.CALDAV_HOST) {
	const url = composeBaseUrl(process.env.CALDAV_HOST, flag("CALDAV_HTTPS", true));
	if (url) process.env.CALDAV_BASE_URL = url;
}

const missing = [];
if (!process.env.CALDAV_BASE_URL) missing.push("NAS-Adresse (CALDAV_HOST)");
if (!process.env.CALDAV_USERNAME) missing.push("Benutzername");
if (!process.env.CALDAV_PASSWORD) missing.push("Passwort");

if (missing.length > 0) {
	console.error(
		`Synology Calendar: missing configuration (${missing.join(", ")}). ` +
			"Open Settings > Extensions and fill in the NAS host name, user and password. " +
			"The host field takes a name like nas.example.com - no https://, no path.",
	);
	process.exit(1);
}

await import("./server/dist/index.js");
