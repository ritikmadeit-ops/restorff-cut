/**
 * Address rules with no Node imports, so the browser side can use them too (security-pass agent, 2026-10-23; moved
 * out of src/server/safe-fetch.ts, which re-exports them and adds DNS, pinning and redirects on the server).
 *
 *   blockedReason(ip)            why an IP must not be fetched (loopback, private, link-local/metadata, …) or null
 *   libraryUrlRefusal(url, origin) why a library-audio sourceUrl must not be fetched, or null
 *
 * libraryUrlRefusal is the guard on the one URL a timeline carries that a page fetches by itself: a library audio
 * element's `sourceUrl` (ops@1 `sfx {url}`, a Freesound preview). The editor fetches it in the person's browser, but
 * the SERVER's headless render (RestorffCut's pipeline, Chromium on the server) fetches it too — so an `sfx` op whose
 * url is `http://169.254.169.254/…` made the server reach its own metadata service (independent review of the security
 * pass, 2026-10-21, finding F1). Allowed: same-origin, blob:, data:, and http(s) to a name that is not a private /
 * loopback / link-local IP literal, localhost, *.localhost, *.local, *.internal or a single-label (intranet) name.
 * LIMIT: a browser can't resolve DNS, so a public name that points at a private address still gets through; closing
 * that needs the render to fetch library audio through safeFetch (or a network allow-list in the headless browser).
 */

export function parseIPv4(text: string): number | null {
	const parts = text.split(".");
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const n = Number(part);
		if (n > 255) return null;
		value = value * 256 + n;
	}
	return value;
}

/** Eight 16-bit groups, or null. Accepts `::` compression and a dotted IPv4 tail; refuses zone ids (`%eth0`). */
export function parseIPv6(input: string): number[] | null {
	let text = input.toLowerCase();
	if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
	if (!text.includes(":") || text.includes("%")) return null;
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const groups = (part: string, dottedTailAllowed: boolean): number[] | null => {
		if (part === "") return [];
		const out: number[] = [];
		const items = part.split(":");
		for (let i = 0; i < items.length; i += 1) {
			const item = items[i];
			if (item.includes(".")) {
				if (!dottedTailAllowed || i !== items.length - 1) return null;
				const v4 = parseIPv4(item);
				if (v4 === null) return null;
				out.push(Math.floor(v4 / 65536), v4 % 65536);
				continue;
			}
			if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
			out.push(Number.parseInt(item, 16));
		}
		return out;
	};
	if (halves.length === 1) {
		const all = groups(halves[0], true);
		return all && all.length === 8 ? all : null;
	}
	const head = groups(halves[0], false);
	const tail = groups(halves[1], true);
	if (!head || !tail) return null;
	const missing = 8 - head.length - tail.length;
	if (missing < 1) return null;
	return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

const V4_BLOCKS: Array<[string, number, string]> = [
	["0.0.0.0", 8, "this-network (0.0.0.0/8)"],
	["10.0.0.0", 8, "private (10/8)"],
	["100.64.0.0", 10, "shared CGNAT (100.64/10; some cloud metadata)"],
	["127.0.0.0", 8, "loopback (127/8)"],
	["169.254.0.0", 16, "link-local (169.254/16; cloud metadata)"],
	["172.16.0.0", 12, "private (172.16/12)"],
	["192.0.0.0", 24, "IETF protocol (192.0.0/24)"],
	["192.0.2.0", 24, "documentation (192.0.2/24)"],
	["192.88.99.0", 24, "6to4 relay (192.88.99/24)"],
	["192.168.0.0", 16, "private (192.168/16)"],
	["198.18.0.0", 15, "benchmarking (198.18/15)"],
	["198.51.100.0", 24, "documentation (198.51.100/24)"],
	["203.0.113.0", 24, "documentation (203.0.113/24)"],
	["224.0.0.0", 4, "multicast (224/4)"],
	["240.0.0.0", 4, "reserved (240/4)"],
];

function v4Reason(value: number): string | null {
	for (const [base, bits, why] of V4_BLOCKS) {
		const size = 2 ** (32 - bits);
		if (Math.floor(value / size) === Math.floor((parseIPv4(base) as number) / size)) return why;
	}
	return null;
}

function v6Reason(g: number[]): string | null {
	const embedded = (hi: number, lo: number) => hi * 65536 + lo;
	if (g.slice(0, 6).every((x) => x === 0)) {
		if (g[6] === 0 && g[7] === 0) return "unspecified (::)";
		if (g[6] === 0 && g[7] === 1) return "loopback (::1)";
		return v4Reason(embedded(g[6], g[7])) ?? "IPv4-compatible (::/96, deprecated)";
	}
	if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Reason(embedded(g[6], g[7])); // ::ffff:a.b.c.d
	if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return "IPv4-translated (::ffff:0:0:0/96)";
	if (g[0] === 0x64 && g[1] === 0xff9b) {
		if (g.slice(2, 6).every((x) => x === 0)) return v4Reason(embedded(g[6], g[7])); // NAT64 64:ff9b::/96
		if (g[2] === 1) return "NAT64 local-use (64:ff9b:1::/48)";
	}
	if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return "discard-only (100::/64)";
	if (g[0] === 0x2001 && g[1] === 0) return "Teredo (2001::/32)";
	if (g[0] === 0x2001 && g[1] === 0xdb8) return "documentation (2001:db8::/32)";
	if (g[0] === 0x2002) return v4Reason(embedded(g[1], g[2])); // 6to4 2002:a.b.c.d::/48
	if ((g[0] & 0xfe00) === 0xfc00) return "unique-local (fc00::/7; private, incl. the AWS metadata fd00:ec2::254)";
	if ((g[0] & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
	if ((g[0] & 0xffc0) === 0xfec0) return "site-local (fec0::/10)";
	if ((g[0] & 0xff00) === 0xff00) return "multicast (ff00::/8)";
	return null;
}

/** Why an address must not be fetched (a class, e.g. "loopback (127/8)"), or null when it is public. Fails closed. */
export function blockedReason(address: string): string | null {
	const v4 = parseIPv4(address);
	if (v4 !== null) return v4Reason(v4);
	const v6 = parseIPv6(address);
	if (v6) return v6Reason(v6);
	return "not an IP address";
}

export const isIpLiteral = (host: string) => parseIPv4(host) !== null || parseIPv6(host) !== null;

const PRIVATE_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa|lan|intranet|corp)$/i;

/**
 * Why a library-audio URL must not be fetched (see the header), or null when it may be. `origin` is the page's own
 * origin (location.origin); relative URLs resolve against it and same-origin is always allowed.
 */
export function libraryUrlRefusal(raw: string, origin: string): string | null {
	let url: URL;
	try {
		url = new URL(raw, origin);
	} catch {
		return "not a URL";
	}
	if (url.protocol === "blob:" || url.protocol === "data:") return null;
	if (url.origin === origin) return null;
	if (url.protocol !== "http:" && url.protocol !== "https:") return `scheme ${url.protocol} is not fetched`;
	if (url.username || url.password) return "a URL with credentials is not fetched";
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
	if (isIpLiteral(host)) {
		const why = blockedReason(host);
		return why ? `${why} address` : null;
	}
	if (!host.includes(".")) return "a single-label (intranet) host";
	if (PRIVATE_NAME.test(host)) return "a local / internal host name";
	return null;
}
