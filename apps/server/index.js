#!/usr/bin/env node
/**
 * Entry point of the Synology Calendar desktop extension.
 *
 * Thin wrapper around the bundled caldav-mcp server (vendor/caldav-mcp/dist/index.js).
 * Above all it does two things the bundled server cannot:
 *
 *   1. Claude Desktop can only inject strings into env, while Node expects the
 *      literal "0" in NODE_TLS_REJECT_UNAUTHORIZED to accept a self-signed
 *      certificate. So CALDAV_VERIFY_SSL is translated here - same name and
 *      same polarity as CARDDAV_VERIFY_SSL in the contacts extension.
 *   2. The settings dialog asks for a host name and a protocol switch, not a
 *      URL. CALDAV_BASE_URL is assembled from those before caldav-mcp reads it.
 *
 * The CalDAV path is appended here, exactly like the contacts extension does.
 * ts-caldav can discover it on its own, but not against DSM: its well-known
 * probe fetches /.well-known/caldav with GET, where DSM answers 404 (only
 * OPTIONS works there), and its fallback candidates carry no trailing slash,
 * where DSM answers 405. Discovery then falls back to the bare origin, DSM
 * serves the web UI with 200 and no principal, and the server dies with
 * "User principal not found" before it ever speaks MCP.
 */

import tls from "node:tls";

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
 * Read a timeout in seconds. Blank, unparsable or non-positive falls back to the
 * default instead of throwing - a typo in that settings field must not be the
 * reason the whole server refuses to start.
 *
 * Seconds, not milliseconds: the contacts extension asks for seconds, and two
 * sibling dialogs where the same number means different things is a trap.
 */
const seconds = (name, fallback) => {
	const secs = Number(String(process.env[name] ?? "").trim());
	// kept inside the range the settings dialog offers: a thousandth of a
	// second would make every request fail before it started
	return Number.isFinite(secs) && secs >= 5 ? Math.min(secs, 600) : fallback;
};

/**
 * Build the CalDAV base URL from a bare host name.
 *
 * People paste whole URLs into any field that looks like it wants one, so a
 * pasted scheme, path or query is stripped rather than rejected: the protocol
 * switch decides the scheme, only an explicit :port survives.
 */
const composeBaseUrl = (host, https) => {
	let h = String(host).trim().replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
	// a backslash counts as a separator too: "\\nas\home" is a Windows path,
	// and its rest must not end up in the address
	h = h.split(/[/\\?#]/)[0].trim().replace(/^\.+|\.+$/g, "");
	if (h.includes("@")) h = h.slice(h.lastIndexOf("@") + 1);
	if (!h) return "";
	// after the last "]" so an IPv6 literal like [::1] is not read as host:port
	if (!h.slice(h.lastIndexOf("]") + 1).includes(":")) {
		h = `${h}:${DEFAULT_PORT[https]}`;
	}
	return `${https ? "https" : "http"}://${h}/caldav/`;
};

if (!flag("CALDAV_VERIFY_SSL", true)) {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
} else if (typeof tls.setDefaultCACertificates === "function") {
	// Node trusts only its built-in list, so a NAS certificate the user trusted
	// in the operating system would still be refused - the contacts extension
	// accepts it. Node 22.19 / 24.5 and newer can add the system store.
	try {
		tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...tls.getCACertificates("system")]);
	} catch {
		// keep Node's own list
	}
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

/*
 * DSM answers the first authenticated request of a session in roughly five
 * seconds and serves every later one from its session cache in milliseconds.
 * ts-caldav hardcodes a 5000 ms axios timeout and caldav-mcp never passes
 * requestTimeout, so that very first PROPFIND loses the race by a hair,
 * discovery throws, and the process exits before it has spoken a word of MCP -
 * all Claude Desktop reports is "Server transport closed unexpectedly".
 *
 * The window is the "Zeitlimit pro Anfrage" field of the extension settings.
 *
 * The path below resolves to the same module instance the bundled server
 * imports as "ts-caldav" (its exports map points "." at dist/index.mjs), so
 * widening the default here reaches the client that server builds. Both files
 * ship inside this package and are pinned together.
 */
const REQUEST_TIMEOUT_MS = seconds("CALDAV_TIMEOUT", 45) * 1000;
const tsCaldav = await import("./vendor/caldav-mcp/node_modules/ts-caldav/dist/index.mjs");

/*
 * Before it looks at the base URL, discovery tries /.well-known/caldav and five
 * guessed paths, one after the other. Against DSM none of them ever works (see
 * the top of this file), and against a NAS that accepts connections but does
 * not answer, each waits out the full request timeout - seven probes plus the
 * real request, six minutes at 45 s, on every tool call. So the base URL is
 * asked first: if it answers, it is the endpoint; if it is not reachable at
 * all, the probes would only repeat that. Only a base URL that answers with an
 * error - another server behind a /.well-known redirect - still gets them.
 */
/*
 * Writes must not be repeated somewhere else. axios follows up to 21
 * redirects, so a PUT answered with "302 to another server" sent the whole
 * appointment there and reported its 201 as success, while the NAS never saw
 * it. Deleting gets its own method here as well: it addresses the object by
 * the address the server gave it, instead of guessing <uid>.ics.
 */
const ICS = "text/calendar; charset=utf-8";
tsCaldav.CalDAVClient.prototype.mkIcsPut = function (href, ics, headers, validate) {
	return this.httpClient.put(href, ics, {
		headers: { "Content-Type": ICS, ...(headers || {}) },
		validateStatus: validate ?? ((s) => s >= 200 && s < 300),
		maxRedirects: 0,
	});
};
tsCaldav.CalDAVClient.prototype.deleteHref = function (href, ifMatch) {
	return this.httpClient.delete(href, {
		headers: { "If-Match": ifMatch || "*" },
		validateStatus: (s) => s === 200 || s === 202 || s === 204,
		maxRedirects: 0,
	});
};

const probeRoots = tsCaldav.CalDAVClient.prototype.tryDiscoveryRoots;
tsCaldav.CalDAVClient.prototype.tryDiscoveryRoots = async function () {
	if (new URL(this.baseUrl).pathname !== "/") {
		const res = await this.httpClient.request({
			method: "OPTIONS",
			url: this.baseUrl,
			validateStatus: () => true,
		});
		if (res.status < 400) return this.baseUrl;
		if (res.status === 401 || res.status === 403) {
			// What the NAS refuses is the login, not the address. Probing on
			// would be seven more refused logins for one tool call, and DSM
			// locks an account out after a handful of those.
			throw new Error(
				`the NAS did not accept the login (HTTP ${res.status}). Check the user name `
					+ "and the password in the extension settings. Note that DSM refuses the "
					+ "calendar to accounts with two-step verification, and that it blocks an "
					+ "account for a while after several refused attempts (Control Panel > "
					+ "Security > Account, and > Protection).",
			);
		}
	}
	return probeRoots.call(this);
};

/*
 * ts-caldav builds the Basic header with btoa(), which takes Latin-1 only: a
 * "€" in the password throws, and umlauts go out as Latin-1, where DSM - and
 * the contacts extension - speak UTF-8. Handing btoa() the UTF-8 bytes as a
 * Latin-1 string makes it encode exactly those bytes.
 */
const utf8 = (s) => Buffer.from(String(s ?? ""), "utf8").toString("latin1");

/*
 * Certificate checking is on by default, so a NAS still on its self-signed
 * certificate fails at the first connection - and axios says only
 * "self-signed certificate", or suggests a Node.js command-line switch nobody
 * using Claude Desktop can set. A fixed reason per error code plus the two ways
 * out replace that. (ts-caldav's own rejectUnauthorized option is no way to
 * switch the check off: in this ES module build its require("https") throws and
 * is swallowed, so the option silently does nothing.)
 */
const CERT_REASONS = {
	DEPTH_ZERO_SELF_SIGNED_CERT: "it is self-signed",
	SELF_SIGNED_CERT_IN_CHAIN: "it comes from a self-signed issuer",
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: "its issuer is unknown",
	UNABLE_TO_GET_ISSUER_CERT: "its issuer is unknown",
	UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "its issuer is unknown",
	CERT_UNTRUSTED: "it is not trusted",
	CERT_SIGNATURE_FAILURE: "its signature is invalid",
	CERT_HAS_EXPIRED: "it has expired",
	CERT_NOT_YET_VALID: "it is not valid yet",
	ERR_TLS_CERT_ALTNAME_INVALID: "it was issued for another name than the NAS address entered",
};
const certReason = (error) => {
	for (let e = error, hops = 0; e && hops < 10; e = e.cause, hops++) {
		if (Object.hasOwn(CERT_REASONS, e.code)) return CERT_REASONS[e.code];
	}
	return null;
};

const createClient = tsCaldav.CalDAVClient.create.bind(tsCaldav.CalDAVClient);
tsCaldav.CalDAVClient.create = async (options) => {
	const auth =
		options.auth?.type === "basic"
			? { ...options.auth, username: utf8(options.auth.username), password: utf8(options.auth.password) }
			: options.auth;
	try {
		return await createClient({ requestTimeout: REQUEST_TIMEOUT_MS, ...options, auth });
	} catch (error) {
		const reason = certReason(error);
		if (!reason) throw error;
		throw new Error(
			`the certificate of the NAS was not accepted: ${reason}. ` +
				"Certificate checking keeps the DSM password from being intercepted. " +
				"Fix it on the NAS: a valid certificate (DSM > Control Panel > Security > " +
				"Certificate, e.g. Let's Encrypt), and the name it was issued for as NAS address. " +
				'Only on your own home network: switch off "Zertifikat prüfen" in the extension settings.',
			{ cause: error },
		);
	}
};

await import("./vendor/caldav-mcp/dist/index.js");
