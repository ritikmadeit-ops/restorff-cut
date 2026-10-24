/**
 * hf-skills (wave 7, 2026-10-24): the playbooks served by MCP `guide` — the files' contract (front matter, sizes,
 * related ids, the tools they name exist), the four answers (index, topic, section, query), the error answers
 * (unknown topic, unknown section), and every topic through the real protocol layer under the result cap.
 * Pure: reads packages/compositions/knowledge from disk, no DB, no dev server.
 * Run: cd apps/web && bun test src/server/__tests__/knowledge.test.ts
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GUIDE_INSTRUCTIONS, GUIDE_TOOL } from "@/mcp/guide";
import { makeMcpHandler, type Payload, type ToolContext, type ToolOutput } from "@/mcp/protocol";
import { SERVER_INSTRUCTIONS, TOOLS } from "@/mcp/tools";
import { KNOWLEDGE_LIMITS, knowledgeIndex, loadKnowledge, parseNext, parseTopic, resolveSection, resolveTopic, searchKnowledge } from "@/server/knowledge";

const ctx = {} as ToolContext;
const run = async (args: Record<string, unknown>): Promise<ToolOutput> => GUIDE_TOOL.run(args, ctx);
const payloadOf = (out: ToolOutput) => out.payload as Payload;
const base = loadKnowledge();
const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

describe("the playbook files", () => {
	test("at least 14 topics, no problems (front matter, credit, sizes, related ids)", () => {
		expect(base.topics.length).toBeGreaterThanOrEqual(14);
		expect(base.problems).toEqual([]);
		for (const id of ["workflow", "composition-authoring", "motion", "captions", "pacing-retention", "qa-loop", "numbers"]) {
			expect(base.topics.some((topic) => topic.id === id)).toBe(true);
		}
	});

	test("size limits: each body, each section, the index", () => {
		for (const topic of base.topics) {
			expect(topic.body.length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.topicChars);
			for (const section of topic.sections) expect(section.text.length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.sectionChars);
			expect(topic.sections.length).toBeGreaterThanOrEqual(3);
		}
		expect(JSON.stringify(knowledgeIndex(base)).length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.indexChars);
	});

	test("every tool a playbook names, and every next, is a real MCP tool", () => {
		for (const topic of base.topics) {
			for (const tool of topic.tools) expect(`${topic.id}: ${tool} ${TOOL_NAMES.has(tool)}`).toBe(`${topic.id}: ${tool} true`);
			expect(topic.next).not.toBeNull();
			expect(`${topic.id}: ${topic.next?.tool} ${TOOL_NAMES.has(topic.next?.tool ?? "")}`).toBe(`${topic.id}: ${topic.next?.tool} true`);
		}
	});

	test("the checker catches a bad file (no front matter, missing keys, oversize, duplicate sections, no credit)", () => {
		expect(parseTopic("x.md", "# x\n\n## a\ntext").problems.join(" ")).toMatch(/no front matter/);
		const missing = parseTopic("y.md", "---\nid: y\ntitle: Y\n---\n# Y\n\nAdapted from HyperFrames skills (Apache-2.0) a@fa5dbd1; modified.\n\n## one\nx");
		expect(missing.problems.join(" ")).toMatch(/lacks "summary"/);
		const big = `---\nid: z\ntitle: Z\nsummary: s\nread_when: r\ntools: guide\nrelated: \nnext: guide | d\nsource: s\n---\n# Z\n\nno credit here\n\n## one\n${"word ".repeat(2_600)}\n\n## one\nagain`;
		const problems = parseTopic("z.md", big).problems.join(" ");
		expect(problems).toMatch(/limit 12000/);
		expect(problems).toMatch(/limit 6000/);
		expect(problems).toMatch(/two sections named "one"/);
		expect(problems).toMatch(/no credit line/);
		expect(parseTopic("other.md", big.replace("id: z", "id: zz")).problems.join(" ")).toMatch(/does not match the file name/);
	});

	test("parseNext reads 'tool action | do'", () => {
		expect(parseNext("composition contract | Read it.")).toEqual({ tool: "composition", action: "contract", do: "Read it." });
		expect(parseNext("render | Render a preview.")).toEqual({ tool: "render", action: null, do: "Render a preview." });
		expect(parseNext("")).toBeNull();
	});

	test("a changed file is re-read without a restart (mtime cache)", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "rc-knowledge-"));
		try {
			const file = (summary: string) => `---\nid: demo\ntitle: Demo\nsummary: ${summary}\nread_when: r\ntools: guide\nrelated: \nnext: guide | d\nsource: s\n---\n# Demo\n\nRestorffCut's own.\n\n## One\na\n`;
			writeFileSync(path.join(dir, "demo.md"), file("first"));
			writeFileSync(path.join(dir, "README.md"), "# not a topic");
			expect(loadKnowledge(dir).topics.map((topic) => topic.summary)).toEqual(["first"]);
			writeFileSync(path.join(dir, "demo.md"), file("second, longer"));
			expect(loadKnowledge(dir).topics.map((topic) => topic.summary)).toEqual(["second, longer"]);
			expect(loadKnowledge(path.join(dir, "missing")).problems[0]).toMatch(/no knowledge folder/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("guide answers", () => {
	test("no arguments: the index (every topic, when to read it, its sections), next = workflow", async () => {
		const out = await run({});
		const p = payloadOf(out);
		expect(out.isError).toBeUndefined();
		const topics = p.topics as Array<{ topic: string; read_when: string; sections: string[] }>;
		expect(topics.length).toBe(base.topics.length);
		expect(topics.every((topic) => topic.read_when.length > 10 && topic.sections.length >= 3)).toBe(true);
		expect(p.next).toEqual({ do: expect.stringContaining("workflow"), tool: "guide", arguments: { topic: "workflow" } });
		expect(JSON.stringify(p).length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.indexChars + 1_000);
	});

	test("topic: the whole playbook text, its sections, and a next that does the work", async () => {
		const p = payloadOf(await run({ topic: "composition-authoring" }));
		expect(p.topic).toBe("composition-authoring");
		expect(String(p.text)).toContain("## The contract in ten lines");
		expect((p.sections as string[])[0]).toMatch(/^1\. /);
		expect(p.next).toMatchObject({ tool: "composition", arguments: { action: "contract" } });
		expect(JSON.stringify(p).length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.topicChars + 3_000);
	});

	test("aliases and close words resolve; case and spaces don't matter", async () => {
		expect(payloadOf(await run({ topic: "gsap" })).topic).toBe("animation-runtimes");
		expect(payloadOf(await run({ topic: "Captions" })).topic).toBe("captions");
		expect(payloadOf(await run({ topic: "retention" })).topic).toBe("pacing-retention");
		expect(payloadOf(await run({ topic: "QA loop" })).topic).toBe("qa-loop");
		const typo = resolveTopic(base, "compositon-autoring");
		expect("suggestions" in typo ? typo.suggestions : [typo.topic.id]).toContain("composition-authoring");
	});

	test("unknown topic: an error naming the closest topics and every id; next = the closest", async () => {
		const out = await run({ topic: "underwater basket weaving" });
		expect(out.isError).toBe(true);
		const error = payloadOf(out).error as { code: string; did_you_mean: string[]; topics: string[] };
		expect(error.code).toBe("unknown_topic");
		expect(error.topics.length).toBe(base.topics.length);
		expect(error.did_you_mean.length).toBeGreaterThan(0);
		expect(payloadOf(out).next).toMatchObject({ tool: "guide" });
	});

	test("section: by name, by a unique part, by number; unknown section lists them", async () => {
		const byName = payloadOf(await run({ topic: "motion", section: "Ease by role" }));
		expect(byName.section).toBe("Ease by role");
		expect(String(byName.text).startsWith("## Ease by role")).toBe(true);
		expect(String(byName.text)).not.toContain("## Titles");
		expect(byName.next).toMatchObject({ tool: "guide", arguments: { topic: "motion" } });
		expect(payloadOf(await run({ topic: "motion", section: "springs" })).section).toBe("Springs and overshoot");
		expect(payloadOf(await run({ topic: "motion", section: 1 })).section).toBe(base.topics.find((t) => t.id === "motion")?.sections[0].name);
		const bad = await run({ topic: "motion", section: "nope nope" });
		expect(bad.isError).toBe(true);
		expect((payloadOf(bad).error as { code: string; sections: string[] }).sections.length).toBeGreaterThanOrEqual(3);
		const motion = base.topics.find((t) => t.id === "motion");
		if (!motion) throw new Error("no motion topic");
		expect(resolveSection(motion, "99")).toBeNull();
	});

	test("query: ranked hits with topic, section and a snippet; nothing found points at the index", async () => {
		const p = payloadOf(await run({ query: "whip transition" }));
		const hits = p.hits as Array<{ topic: string; section: string; snippet: string }>;
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.searchHits);
		expect(hits[0].topic).toBe("transitions");
		expect(hits.every((hit) => hit.snippet.length <= KNOWLEDGE_LIMITS.snippetChars + 2)).toBe(true);
		expect(p.next).toMatchObject({ tool: "guide", arguments: { topic: "transitions" } });
		expect(searchKnowledge(base, "count-up").some((hit) => hit.topic === "numbers")).toBe(true);
		const none = payloadOf(await run({ query: "zzqxj" }));
		expect(none.hits).toEqual([]);
		expect(none.next).toEqual({ do: expect.any(String), tool: "guide", arguments: {} });
	});

	test("registered: in TOOLS once, read-only, and the server instructions point at it", () => {
		expect(TOOLS.filter((tool) => tool.name === "guide").length).toBe(1);
		expect(GUIDE_TOOL.annotations?.readOnlyHint).toBe(true);
		expect(SERVER_INSTRUCTIONS).toContain(GUIDE_INSTRUCTIONS);
		expect(GUIDE_TOOL.description).toContain("composition-authoring");
	});
});

describe("through the protocol layer", () => {
	test("every topic answers under the result cap, never an error, next last", async () => {
		const handle = makeMcpHandler({ serverInfo: { name: "t", version: "0" }, tools: [GUIDE_TOOL] });
		const post = (body: unknown, session?: string) =>
			handle(new Request("http://localhost/api/mcp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}) } }));
		const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
		const session = init.headers.get("mcp-session-id") as string;
		let id = 2;
		const call = async (args: Record<string, unknown>) =>
			(await (await post({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "guide", arguments: args } }, session)).json()) as {
				result: { isError?: boolean; structuredContent: Payload; content: Array<{ text: string }> };
			};
		const sizes: number[] = [];
		for (const topic of base.topics) {
			const reply = await call({ topic: topic.id });
			expect(reply.result.isError).toBeUndefined();
			const keys = Object.keys(reply.result.structuredContent);
			expect(keys[keys.length - 1]).toBe("next");
			sizes.push(reply.result.content[0].text.length);
		}
		expect(Math.max(...sizes)).toBeLessThanOrEqual(16_000);
		const index = await call({});
		expect(index.result.content[0].text.length).toBeLessThanOrEqual(KNOWLEDGE_LIMITS.indexChars + 1_000);
		const wrong = await call({ topic: 42 });
		expect(wrong.result.isError).toBe(true);
		expect(JSON.stringify(wrong.result.structuredContent)).toContain("invalid_arguments");
	});
});
