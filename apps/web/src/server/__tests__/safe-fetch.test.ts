/**
 * security-pass (2026-10-21): the SSRF guard every server-side URL fetch goes through (src/server/safe-fetch.ts) —
 * loopback, private, metadata, DNS-to-private, a redirect to private, pinning, the dev allow-list, size and time caps —
 * and the two callers (media import {url}, references add {url}). Local servers on 127.0.0.1 only; nothing leaves the
 * machine. Run: cd apps/web && bun test src/server/__tests__/safe-fetch.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { HttpError } from "@/server/http";
import { addReferenceFiles } from "@/server/references-store";
import { discard, stageFromUrl } from "@/server/media-import";
import { blockedReason, fetchAllowList, parseIPv6, safeFetch } from "@/server/safe-fetch";

let server: http.Server;
let other: http.Server;
let port = 0;
let otherPort = 0;
const seen: Array<{ path: string; host: string | undefined }> = [];

beforeAll(async () => {
	server = http.createServer((req, res) => {
		seen.push({ path: req.url ?? "", host: req.headers.host });
		const url = new URL(req.url ?? "/", "http://x");
		const go = (location: string) => {
			res.writeHead(302, { location });
			res.end();
		};
		if (url.pathname === "/clip.mp4") {
			res.writeHead(200, { "content-type": "video/mp4", "content-length": "11" });
			res.end("hello world");
		} else if (url.pathname === "/to-metadata") go("http://169.254.169.254/latest/meta-data/");
		else if (url.pathname === "/to-private") go("http://10.0.0.1/clip.mp4");
		else if (url.pathname === "/to-other-port") go(`http://127.0.0.1:${otherPort}/clip.mp4`);
		else if (url.pathname === "/to-ipv6-loopback") go(`http://[::1]:${port}/clip.mp4`);
		else if (url.pathname === "/to-file") go("file:///etc/passwd");
		else if (url.pathname === "/to-same") go("/clip.mp4");
		else if (url.pathname === "/loop") go("/loop");
		else if (url.pathname === "/big") {
			res.writeHead(200, { "content-type": "video/mp4", "content-length": "5000" });
			res.end(Buffer.alloc(5000));
		} else if (url.pathname === "/big-chunked") {
			res.writeHead(200, { "content-type": "video/mp4" });
			res.write(Buffer.alloc(3000));
			res.end(Buffer.alloc(3000));
		} else if (url.pathname === "/hang") {
			res.writeHead(200, { "content-type": "video/mp4" });
			res.write("x"); // then nothing
		} else {
			res.writeHead(404);
			res.end("no");
		}
	});
	other = http.createServer((_req, res) => {
		res.writeHead(200);
		res.end("other port");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	otherPort = (other.address() as AddressInfo).port;
});

afterAll(() => {
	server.closeAllConnections?.();
	server.close();
	other.close();
});

const savedAllow = process.env.RESTORFFCUT_FETCH_ALLOW;
const savedEnv = process.env.NODE_ENV;
afterEach(() => {
	if (savedAllow === undefined) delete process.env.RESTORFFCUT_FETCH_ALLOW;
	else process.env.RESTORFFCUT_FETCH_ALLOW = savedAllow;
	(process.env as Record<string, string | undefined>).NODE_ENV = savedEnv;
});

const allowLocal = () => {
	process.env.RESTORFFCUT_FETCH_ALLOW = `127.0.0.1:${port}`;
};

async function refusal(promise: Promise<unknown>): Promise<HttpError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(HttpError);
		return error as HttpError;
	}
	throw new Error("expected a refusal, got an answer");
}

const text = async (body: ReadableStream<Uint8Array>) => Buffer.from(await new Response(body).arrayBuffer()).toString("utf8");

describe("blockedReason: every private, loopback, link-local and metadata form", () => {
	test.each([
		["127.0.0.1", /loopback/],
		["127.255.0.9", /loopback/],
		["10.1.2.3", /private/],
		["172.16.0.1", /private/],
		["172.31.255.255", /private/],
		["192.168.1.20", /private/],
		["169.254.169.254", /link-local/],
		["100.100.100.200", /CGNAT/],
		["0.0.0.0", /this-network/],
		["224.0.0.1", /multicast/],
		["255.255.255.255", /reserved/],
		["::1", /loopback/],
		["::", /unspecified/],
		["::ffff:127.0.0.1", /loopback/],
		["::ffff:7f00:1", /loopback/],
		["::ffff:a9fe:a9fe", /link-local/],
		["::127.0.0.1", /loopback/],
		["fc00::1", /unique-local/],
		["fd00:ec2::254", /unique-local/],
		["fe80::1", /link-local/],
		["ff02::1", /multicast/],
		["64:ff9b::a00:1", /private/],
		["2002:c0a8:101::1", /private/],
		["2001:db8::1", /documentation/],
		["not-an-ip", /not an IP/],
		["fe80::1%eth0", /not an IP/],
	])("%s is refused", (address, why) => {
		expect(blockedReason(address)).toMatch(why);
	});

	test.each(["8.8.8.8", "172.32.0.1", "100.128.0.1", "93.184.216.34", "::ffff:8.8.8.8", "2606:4700::6810:84e5", "64:ff9b::808:808"])("%s is public", (address) => {
		expect(blockedReason(address)).toBeNull();
	});

	test("IPv6 parsing: compression, a dotted tail, and malformed forms", () => {
		expect(parseIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
		expect(parseIPv6("[::ffff:10.0.0.1]")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001]);
		expect(parseIPv6("1::2::3")).toBeNull();
		expect(parseIPv6("1.2.3.4::")).toBeNull();
		expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
	});
});

describe("safeFetch refuses before connecting", () => {
	test("loopback, by every spelling the URL parser normalises to 127.0.0.1", async () => {
		const before = seen.length;
		for (const url of [`http://127.0.0.1:${port}/clip.mp4`, `http://localhost:${port}/clip.mp4`, `http://2130706433:${port}/clip.mp4`, `http://0x7f.1:${port}/clip.mp4`, `http://127.1:${port}/clip.mp4`, `http://[::1]:${port}/clip.mp4`, `http://[::ffff:127.0.0.1]:${port}/clip.mp4`]) {
			const error = await refusal(safeFetch(url));
			expect(error.status).toBe(403);
			expect(error.extra?.reason).toBe("blocked_address");
		}
		expect(seen.length).toBe(before);
	});

	test("private and metadata addresses", async () => {
		for (const url of ["http://10.0.0.1/a.mp4", "http://192.168.0.10/a.mp4", "http://172.20.1.1/a.mp4", "http://169.254.169.254/latest/meta-data/", "http://[fd00:ec2::254]/latest/meta-data/", "http://0.0.0.0/"]) {
			const error = await refusal(safeFetch(url));
			expect(error.status).toBe(403);
		}
	});

	test("a name that resolves to a private address (any of its addresses)", async () => {
		const lookups: string[] = [];
		const lookup = async (host: string) => {
			lookups.push(host);
			return host === "mixed.example.test"
				? [
						{ address: "93.184.216.34", family: 4 },
						{ address: "10.0.0.7", family: 4 },
					]
				: [{ address: "10.0.0.7", family: 4 }];
		};
		const one = await refusal(safeFetch("http://intranet.example.test/a.mp4", { lookup }));
		expect(one.status).toBe(403);
		expect(one.message).toContain("resolves to a private");
		expect(one.message).not.toContain("10.0.0.7"); // the resolved IP is never told
		expect((await refusal(safeFetch("https://mixed.example.test/a.mp4", { lookup }))).status).toBe(403);
		expect(lookups).toEqual(["intranet.example.test", "mixed.example.test"]);
	});

	test("not http(s), credentials, not a URL", async () => {
		expect((await refusal(safeFetch("file:///etc/passwd"))).status).toBe(400);
		expect((await refusal(safeFetch("ftp://example.com/a.mp4"))).status).toBe(400);
		expect((await refusal(safeFetch("http://user:pass@example.com/a.mp4"))).status).toBe(400);
		expect((await refusal(safeFetch("not a url"))).status).toBe(400);
	});
});

describe("the dev allow-list (RESTORFFCUT_FETCH_ALLOW)", () => {
	test("off by default; exact host:port only; ignored in production", async () => {
		expect(fetchAllowList(undefined).size).toBe(0);
		expect((await refusal(safeFetch(`http://127.0.0.1:${port}/clip.mp4`))).status).toBe(403);
		allowLocal();
		const ok = await safeFetch(`http://127.0.0.1:${port}/clip.mp4`);
		expect(ok.status).toBe(200);
		expect(await text(ok.body)).toBe("hello world");
		expect((await refusal(safeFetch(`http://127.0.0.1:${otherPort}/clip.mp4`))).status).toBe(403);
		(process.env as Record<string, string | undefined>).NODE_ENV = "production";
		expect((await refusal(safeFetch(`http://127.0.0.1:${port}/clip.mp4`))).status).toBe(403);
	});

	test("the connection goes to the checked address: Host stays the name, DNS is asked once", async () => {
		allowLocal();
		let calls = 0;
		// a rebinding resolver: the allow-listed loopback first, a metadata address on any later ask
		const lookup = async () => (++calls === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "169.254.169.254", family: 4 }]);
		const before = seen.length;
		const ok = await safeFetch(`http://media.example.test:${port}/clip.mp4`, { lookup });
		expect(await text(ok.body)).toBe("hello world");
		expect(calls).toBe(1);
		expect(seen.slice(before)).toEqual([{ path: "/clip.mp4", host: `media.example.test:${port}` }]);
	});
});

describe("redirects are re-checked", () => {
	test("to metadata, to a private address, to another port, to IPv6 loopback, to file: refused", async () => {
		allowLocal();
		for (const [path, status] of [
			["/to-metadata", 403],
			["/to-private", 403],
			["/to-other-port", 403],
			["/to-ipv6-loopback", 403],
			["/to-file", 400],
		] as const) {
			const error = await refusal(safeFetch(`http://127.0.0.1:${port}${path}`));
			expect([path, error.status]).toEqual([path, status]);
		}
	});

	test("a redirect to an allowed URL is followed; a loop stops at 5", async () => {
		allowLocal();
		const ok = await safeFetch(`http://127.0.0.1:${port}/to-same`);
		expect(ok.redirects).toBe(1);
		expect(ok.url).toBe(`http://127.0.0.1:${port}/clip.mp4`);
		expect(await text(ok.body)).toBe("hello world");
		const loop = await refusal(safeFetch(`http://127.0.0.1:${port}/loop`));
		expect([loop.status, loop.extra?.reason]).toEqual([502, "redirects"]);
	});
});

describe("size and time caps", () => {
	test("Content-Length over the cap: refused up front; a chunked body over it: the read fails", async () => {
		allowLocal();
		expect((await refusal(safeFetch(`http://127.0.0.1:${port}/big`, { maxBytes: 1000 }))).status).toBe(413);
		const chunked = await safeFetch(`http://127.0.0.1:${port}/big-chunked`, { maxBytes: 4000 });
		expect((await refusal(text(chunked.body))).status).toBe(413);
	});

	test("a server that stops sending: 504 at the time cap", async () => {
		allowLocal();
		const started = Date.now();
		const response = await safeFetch(`http://127.0.0.1:${port}/hang`, { timeoutMs: 400 });
		const error = await refusal(text(response.body));
		expect(error.status).toBe(504);
		expect(Date.now() - started).toBeLessThan(5000);
	});
});

describe("the callers use it", () => {
	test("media import {url}: loopback refused; allowed with the allow-list", async () => {
		const error = await refusal(stageFromUrl(`http://127.0.0.1:${port}/clip.mp4`));
		expect([error.status, error.extra?.reason]).toEqual([403, "blocked_address"]);
		expect((await refusal(stageFromUrl("http://169.254.169.254/latest/meta-data/"))).status).toBe(403);
		allowLocal();
		const staged = await stageFromUrl(`http://127.0.0.1:${port}/clip.mp4`);
		try {
			expect([staged.size, staged.nameHint, staged.source]).toEqual([11, "clip.mp4", "url"]);
		} finally {
			discard(staged);
		}
		// allowed host, but a redirect to metadata: still refused
		expect((await refusal(stageFromUrl(`http://127.0.0.1:${port}/to-metadata`))).status).toBe(403);
	});

	test("references add {url}: a private URL is skipped with the reason, nothing is fetched", async () => {
		const before = seen.length;
		const result = await addReferenceFiles("security-pass-test-refs", [{ url: `http://127.0.0.1:${port}/clip.mp4` }, { url: "http://169.254.169.254/latest/meta-data/" }]);
		expect(result.added).toEqual([]);
		expect(result.skipped.map((s) => s.reason)).toEqual([expect.stringContaining("not fetched"), expect.stringContaining("not fetched")]);
		expect(seen.length).toBe(before);
	});
});
