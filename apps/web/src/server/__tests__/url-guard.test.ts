/**
 * security-pass (2026-10-23), independent review finding F1: a library audio element's sourceUrl (ops@1 `sfx {url}`)
 * is fetched by the headless render on the server. src/lib/url-guard.ts libraryUrlRefusal is the guard every such
 * fetch goes through (media/audio.ts fetchLibraryUrl, beats/analyze.ts). Run: cd apps/web && bun test
 * src/server/__tests__/url-guard.test.ts
 */
import { describe, expect, test } from "bun:test";
import { libraryUrlRefusal } from "@/lib/url-guard";
import { fetchLibraryUrl } from "@/media/audio";

const ORIGIN = "http://localhost:8791";

describe("library audio URLs (render-time fetch)", () => {
	test.each([
		"/sfx/whoosh-short.wav",
		"/music/warm-90.ogg",
		"/api/voice/takes/abc.wav",
		`${ORIGIN}/sfx/swish.wav`,
		"https://cdn.freesound.org/previews/123/123456_789-lq.mp3",
		"blob:http://localhost:8791/2b1f",
		"data:audio/wav;base64,UklGRg==",
	])("allowed: %s", (url) => {
		expect(libraryUrlRefusal(url, ORIGIN)).toBeNull();
	});

	test.each([
		"http://169.254.169.254/latest/meta-data/",
		"http://[fd00:ec2::254]/latest/meta-data/",
		"http://10.0.0.5/a.wav",
		"http://192.168.1.10:8080/a.wav",
		"http://127.0.0.1:8789/mcp",
		"http://2130706433/a.wav",
		"http://0x7f.1/a.wav",
		"http://[::ffff:127.0.0.1]/a.wav",
		"http://localhost:8795/a.wav",
		"http://metadata.google.internal/computeMetadata/v1/",
		"http://printer.local/a.wav",
		"http://intranet/a.wav",
		"file:///etc/passwd",
		"ftp://example.com/a.wav",
		"http://user:pass@example.com/a.wav",
	])("refused: %s", (url) => {
		expect(libraryUrlRefusal(url, ORIGIN)).not.toBeNull();
	});

	test("fetchLibraryUrl refuses before any request (the render's fetch never sees a metadata URL)", async () => {
		const real = globalThis.fetch;
		const asked: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			asked.push(String(input));
			return new Response("x");
		}) as typeof fetch;
		try {
			await expect(fetchLibraryUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/refused/);
			expect(asked).toEqual([]);
			await fetchLibraryUrl("https://cdn.freesound.org/previews/1/1_2-lq.mp3");
			expect(asked).toEqual(["https://cdn.freesound.org/previews/1/1_2-lq.mp3"]);
		} finally {
			globalThis.fetch = real;
		}
	});
});
