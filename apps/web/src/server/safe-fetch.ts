/**
 * safeFetch: the one way RestorffCut's server fetches a URL that somebody else named (security-pass agent, 2026-10-21).
 * Used by `media import {url}` (media-import.ts stageFromUrl) and `references add {url}` (references-store.ts). A
 * Claude over MCP chooses the URL, so a plain fetch() would let it make this server read its own loopback, the LAN or
 * a cloud metadata service (SSRF). What safeFetch does instead:
 *
 *   - http and https only; no user:password@ in the URL
 *   - resolves the host first and refuses it when ANY of its addresses is loopback, private, link-local, CGNAT,
 *     multicast, reserved, documentation, or a cloud metadata address (`blockedReason` below has the full list;
 *     IPv4-mapped / NAT64 / 6to4 IPv6 forms are checked as the IPv4 address inside them)
 *   - connects to the address it checked (the socket goes to that IP; the Host header and the TLS name stay the URL's
 *     host), so a DNS answer that changes between the check and the connect (DNS rebinding) can't move the request
 *   - follows redirects itself (at most 5), checking every new URL the same way before connecting
 *   - caps time (the whole fetch, body included; default 120 s) and size (Content-Length up front, and the bytes
 *     actually read); asks for no compression, so the cap counts real bytes
 *
 *   RESTORFFCUT_FETCH_ALLOW  dev only, OFF by default and ignored when NODE_ENV=production: comma-separated
 *                            host:port pairs that may be private, e.g. `127.0.0.1:8797` (the gateway's live-test media
 *                            server). Exact host:port only — another port on the same host is still refused. IPv6 as
 *                            `[::1]:8797`. Read on every call.
 *
 * Errors are HttpError: 400 (not http/https, credentials, bad URL), 403 (a blocked address; `extra.reason` =
 * "blocked_address"), 413 (too large), 502 (DNS failure, too many or bad redirects), 504 (over the time cap).
 * The resolved IP is never put in an error message (it would tell a caller what internal names resolve to).
 * Runbook + tests: docs/restorff/worklog/security-pass.md, src/server/__tests__/safe-fetch.test.ts.
 */
import { promises as dns } from "node:dns";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import { Readable, Transform } from "node:stream";
import { blockedReason, isIpLiteral, parseIPv4, parseIPv6 } from "@/lib/url-guard";
import { HttpError } from "./http";

export const SAFE_FETCH_DEFAULT_TIMEOUT_MS = 120_000;
export const SAFE_FETCH_DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
export const SAFE_FETCH_MAX_REDIRECTS = 5;

export interface ResolvedAddress {
	address: string;
	family: number;
}

export interface SafeFetchOptions {
	/** The caller's abort (the MCP call going away); the time cap is added to it. */
	signal?: AbortSignal;
	/** The whole fetch, redirects and body included. Default 120 s. */
	timeoutMs?: number;
	/** Largest body. Default 1 GiB. */
	maxBytes?: number;
	/** Default 5. */
	maxRedirects?: number;
	/** Extra request headers (Host, Accept-Encoding and User-Agent are set here and can't be overridden). */
	headers?: Record<string, string>;
	/** Tests only: a resolver in place of DNS. */
	lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
}

export interface SafeResponse {
	ok: boolean;
	status: number;
	statusText: string;
	headers: Headers;
	/** The body, capped at maxBytes (reading past it errors with HttpError 413). */
	body: ReadableStream<Uint8Array>;
	/** The URL after redirects. */
	url: string;
	redirects: number;
}

// ─── addresses (pure: src/lib/url-guard.ts, which the browser side uses too) ────────────────────────────────────

export { blockedReason, parseIPv4, parseIPv6 };

const isLiteral = isIpLiteral;

// ─── the allow-list (dev only) ──────────────────────────────────────────────────────────────────────────────────

let warnedProduction = false;

/** RESTORFFCUT_FETCH_ALLOW as a set of lower-case `host:port` entries; empty in production (and by default). */
export function fetchAllowList(raw: string | undefined = process.env.RESTORFFCUT_FETCH_ALLOW): Set<string> {
	const entries = (raw ?? "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):\d{1,5}$/.test(entry));
	if (entries.length && process.env.NODE_ENV === "production") {
		if (!warnedProduction) console.warn("[safe-fetch] RESTORFFCUT_FETCH_ALLOW is ignored in production");
		warnedProduction = true;
		return new Set();
	}
	return new Set(entries);
}

const hostKey = (host: string) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host).toLowerCase();

// ─── one hop ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Target {
	address: string;
	family: 4 | 6;
	port: number;
	literal: boolean;
}

const defaultLookup = async (hostname: string): Promise<ResolvedAddress[]> => dns.lookup(hostname, { all: true, verbatim: true });

/** Checks one URL (scheme, credentials, every address it resolves to) and returns the address to connect to. */
export async function checkUrl(url: URL, lookup: SafeFetchOptions["lookup"] = defaultLookup): Promise<Target> {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new HttpError(400, `only http and https URLs are fetched, not ${url.protocol}`, { reason: "protocol" });
	}
	if (url.username || url.password) throw new HttpError(400, "URLs with a user name or password are not fetched", { reason: "credentials" });
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (!host) throw new HttpError(400, "the URL has no host", { reason: "host" });
	const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
	const literal = isLiteral(host);
	let addresses: ResolvedAddress[];
	if (literal) addresses = [{ address: host, family: parseIPv4(host) !== null ? 4 : 6 }];
	else {
		try {
			addresses = await lookup(host);
		} catch (error) {
			throw new HttpError(502, `could not resolve ${host}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, { reason: "dns" });
		}
		if (!addresses.length) throw new HttpError(502, `${host} has no address`, { reason: "dns" });
	}
	const allow = fetchAllowList();
	for (const entry of addresses) {
		const why = blockedReason(entry.address);
		if (!why) continue;
		if (allow.has(`${hostKey(host)}:${port}`) || allow.has(`${hostKey(entry.address)}:${port}`)) continue;
		throw new HttpError(
			403,
			`${url.host} is not fetched: ${literal ? "it is" : "it resolves to"} a ${why} address. The server fetches public http(s) URLs only; send the file as data_base64 or through upload_url instead.`,
			{ reason: "blocked_address", class: why },
		);
	}
	const pick = addresses[0];
	return { address: pick.address, family: pick.family === 6 ? 6 : 4, port, literal };
}

function send(url: URL, target: Target, signal: AbortSignal, headers: Record<string, string>): Promise<IncomingMessage> {
	const secure = url.protocol === "https:";
	const options: https.RequestOptions = {
		// the checked address, not the name: the socket can't land anywhere else
		host: target.address,
		family: target.family,
		port: target.port,
		path: `${url.pathname}${url.search}`,
		method: "GET",
		headers: { accept: "*/*", ...headers, host: url.host, "accept-encoding": "identity", "user-agent": "RestorffCut (media fetch)" },
		// TLS: SNI and the certificate check use the URL's name (none for an IP literal)
		...(secure && !target.literal ? { servername: url.hostname } : {}),
		agent: false,
		signal,
	};
	return new Promise((resolve, reject) => {
		const request = secure ? https.request(options, resolve) : http.request(options, resolve);
		request.on("error", reject);
		request.end();
	});
}

function toHeaders(raw: IncomingHttpHeaders): Headers {
	const out = new Headers();
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		for (const item of Array.isArray(value) ? value : [value]) out.append(key, item);
	}
	return out;
}

function capped(response: IncomingMessage, maxBytes: number, timedOut: () => HttpError | null): ReadableStream<Uint8Array> {
	let size = 0;
	const counter = new Transform({
		transform(chunk: Buffer, _encoding, done) {
			size += chunk.length;
			if (size > maxBytes) done(new HttpError(413, `the file is larger than ${Math.round(maxBytes / 1048576)} MB`, { reason: "too_large" }));
			else done(null, chunk);
		},
	});
	response.on("error", (error) => counter.destroy(timedOut() ?? error));
	counter.on("error", () => response.destroy());
	response.pipe(counter);
	return Readable.toWeb(counter) as unknown as ReadableStream<Uint8Array>;
}

// ─── safeFetch ──────────────────────────────────────────────────────────────────────────────────────────────────

export async function safeFetch(input: string | URL, options: SafeFetchOptions = {}): Promise<SafeResponse> {
	const timeoutMs = options.timeoutMs ?? SAFE_FETCH_DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? SAFE_FETCH_DEFAULT_MAX_BYTES;
	const maxRedirects = options.maxRedirects ?? SAFE_FETCH_MAX_REDIRECTS;
	let url: URL;
	try {
		url = typeof input === "string" ? new URL(input) : new URL(input.href);
	} catch {
		throw new HttpError(400, `not a URL: ${String(input).slice(0, 200)}`, { reason: "url" });
	}
	const deadline = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	const timedOut = () => (deadline.aborted ? new HttpError(504, `${url.host} took longer than ${Math.round(timeoutMs / 1000)} s`, { reason: "timeout" }) : null);
	for (let redirects = 0; ; redirects += 1) {
		const target = await checkUrl(url, options.lookup);
		let response: IncomingMessage;
		try {
			response = await send(url, target, signal, options.headers ?? {});
		} catch (error) {
			throw timedOut() ?? (options.signal?.aborted ? error : new HttpError(502, `could not fetch ${url.host}: ${(error as Error).message}`, { reason: "connect" }));
		}
		const status = response.statusCode ?? 0;
		const location = response.headers.location;
		if (status >= 300 && status < 400 && status !== 304 && location) {
			response.resume();
			if (redirects >= maxRedirects) throw new HttpError(502, `${url.host} redirected more than ${maxRedirects} times`, { reason: "redirects" });
			try {
				url = new URL(location, url);
			} catch {
				throw new HttpError(502, `${url.host} redirected to something that is not a URL`, { reason: "redirects" });
			}
			continue; // the next hop is checked like the first
		}
		const declared = Number(response.headers["content-length"] ?? "0");
		if (declared > maxBytes) {
			response.destroy();
			throw new HttpError(413, `the file is ${Math.round(declared / 1048576)} MB; the limit is ${Math.round(maxBytes / 1048576)} MB`, { reason: "too_large" });
		}
		return {
			ok: status >= 200 && status < 300,
			status,
			statusText: response.statusMessage ?? "",
			headers: toHeaders(response.headers),
			body: capped(response, maxBytes, timedOut),
			url: url.href,
			redirects,
		};
	}
}
