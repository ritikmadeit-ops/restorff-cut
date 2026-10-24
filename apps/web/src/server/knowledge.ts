/**
 * The playbooks (hf-skills agent, wave 7, 2026-10-24; plan/INBOX I-8, I-10): craft know-how adapted from HyperFrames'
 * agent skills (Apache-2.0, @fa5dbd1) into packages/compositions/knowledge/<topic>.md, served one topic at a time by
 * the MCP `guide` tool (../mcp/guide.ts) so any model gets it from RestorffCut, not from its own memory.
 *
 * File contract (packages/compositions/knowledge/README.md): YAML-like front matter (id, title, summary, read_when,
 * aliases?, tools, related, next, source), then a markdown body whose `## ` headings are the sections a client can ask
 * for. Read from disk on every call when a file changed (mtime), so an edit shows without a restart.
 *
 * Paths: KNOWLEDGE_DIR = RESTORFFCUT_KNOWLEDGE_DIR, else <COMPOSITIONS_DIR>/knowledge (COMPOSITIONS_DIR is the one place
 * the package path lives: app/api/compositions/_lib/service.ts).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMPOSITIONS_DIR } from "@/app/api/compositions/_lib/service";

export const KNOWLEDGE_DIR = resolve(process.env.RESTORFFCUT_KNOWLEDGE_DIR?.trim() || join(COMPOSITIONS_DIR, "knowledge"));

/** Answer sizes (chars). The tests hold every file to them, so no answer grows past a small read. */
export const KNOWLEDGE_LIMITS = {
	topicChars: 12_000,
	sectionChars: 6_000,
	indexChars: 7_000,
	searchHits: 8,
	snippetChars: 220,
} as const;

export interface KnowledgeSection {
	name: string;
	slug: string;
	text: string;
}

export interface KnowledgeNext {
	tool: string;
	action: string | null;
	do: string;
}

export interface KnowledgeTopic {
	id: string;
	file: string;
	title: string;
	summary: string;
	readWhen: string;
	aliases: string[];
	tools: string[];
	related: string[];
	next: KnowledgeNext | null;
	source: string;
	/** The markdown after the front matter. */
	body: string;
	/** The body before the first `## ` (title + credit line). */
	lead: string;
	sections: KnowledgeSection[];
	problems: string[];
}

export interface KnowledgeBase {
	dir: string;
	topics: KnowledgeTopic[];
	problems: string[];
}

const REQUIRED = ["id", "title", "summary", "read_when", "tools", "related", "next", "source"] as const;

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

const list = (value: string | undefined): string[] =>
	(value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

/** `tool action | the do-line` → {tool, action, do}. */
export function parseNext(value: string | undefined): KnowledgeNext | null {
	if (!value?.trim()) return null;
	const [head, ...rest] = value.split("|");
	const words = head.trim().split(/\s+/).filter(Boolean);
	if (!words.length) return null;
	return { tool: words[0], action: words[1] ?? null, do: rest.join("|").trim() || `Use ${words.join(" ")}.` };
}

/** One playbook file → a topic (with the problems found; the caller decides whether to serve it). */
export function parseTopic(file: string, text: string): KnowledgeTopic {
	const problems: string[] = [];
	const normalized = text.replace(/\r\n/g, "\n");
	const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
	const meta: Record<string, string> = {};
	if (!match) problems.push(`${file}: no front matter (--- … ---)`);
	else {
		for (const line of match[1].split("\n")) {
			const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
			if (kv) meta[kv[1]] = kv[2].trim();
		}
	}
	for (const key of REQUIRED) if (!meta[key]) problems.push(`${file}: front matter lacks "${key}"`);
	const body = (match ? normalized.slice(match[0].length) : normalized).trim();
	const parts = body.split(/\n(?=## )/);
	const lead = parts[0].startsWith("## ") ? "" : parts.shift() ?? "";
	const sections: KnowledgeSection[] = parts.map((part) => {
		const name = part.slice(3, part.indexOf("\n") < 0 ? undefined : part.indexOf("\n")).trim();
		return { name, slug: slugify(name), text: part.trim() };
	});
	const id = meta.id ?? file.replace(/\.md$/, "");
	if (meta.id && `${meta.id}.md` !== file) problems.push(`${file}: id "${meta.id}" does not match the file name`);
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) problems.push(`${file}: id "${id}" is not kebab-case`);
	if (!/Adapted from HyperFrames|RestorffCut's own/.test(lead)) problems.push(`${file}: no credit line before the first section`);
	if (body.length > KNOWLEDGE_LIMITS.topicChars) problems.push(`${file}: body is ${body.length} chars (limit ${KNOWLEDGE_LIMITS.topicChars}): split the topic`);
	const seen = new Set<string>();
	for (const section of sections) {
		if (section.text.length > KNOWLEDGE_LIMITS.sectionChars) problems.push(`${file}: section "${section.name}" is ${section.text.length} chars (limit ${KNOWLEDGE_LIMITS.sectionChars})`);
		if (seen.has(section.slug)) problems.push(`${file}: two sections named "${section.name}"`);
		seen.add(section.slug);
	}
	const next = parseNext(meta.next);
	return {
		id,
		file,
		title: meta.title ?? id,
		summary: meta.summary ?? "",
		readWhen: meta.read_when ?? "",
		aliases: list(meta.aliases).map(slugify),
		tools: list(meta.tools),
		related: list(meta.related),
		next,
		source: meta.source ?? "",
		body,
		lead: lead.trim(),
		sections,
		problems,
	};
}

/** The cache: the parsed base plus the file stamps it was built from. */
let cache: { dir: string; stamp: string; base: KnowledgeBase } | null = null;

function stampOf(dir: string, files: string[]): string {
	return files
		.map((file) => {
			const stat = statSync(join(dir, file));
			return `${file}:${stat.mtimeMs}:${stat.size}`;
		})
		.join("|");
}

/** Every topic in the folder (README.md excluded), re-read when a file changed. Never throws on a bad file. */
export function loadKnowledge(dir: string = KNOWLEDGE_DIR): KnowledgeBase {
	if (!existsSync(dir)) return { dir, topics: [], problems: [`no knowledge folder at ${dir}`] };
	const files = readdirSync(dir)
		.filter((file) => file.endsWith(".md") && file.toLowerCase() !== "readme.md")
		.sort();
	const stamp = stampOf(dir, files);
	if (cache && cache.dir === dir && cache.stamp === stamp) return cache.base;
	const topics = files.map((file) => parseTopic(file, readFileSync(join(dir, file), "utf8")));
	const ids = new Set(topics.map((topic) => topic.id));
	const problems = topics.flatMap((topic) => topic.problems);
	for (const topic of topics) {
		for (const related of topic.related) if (!ids.has(related)) problems.push(`${topic.file}: related "${related}" is not a topic`);
	}
	const base = { dir, topics, problems };
	cache = { dir, stamp, base };
	return base;
}

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const keep = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = keep;
		}
	}
	return row[b.length];
}

/** A topic by id, alias, or a unique prefix / contained word; else the closest ids. */
export function resolveTopic(base: KnowledgeBase, asked: string): { topic: KnowledgeTopic } | { suggestions: string[] } {
	const want = slugify(asked);
	if (!want) return { suggestions: [] };
	const exact = base.topics.find((topic) => topic.id === want) ?? base.topics.find((topic) => topic.aliases.includes(want));
	if (exact) return { topic: exact };
	const loose = base.topics.filter((topic) => topic.id.startsWith(want) || want.startsWith(topic.id) || topic.id.split("-").includes(want) || topic.aliases.some((alias) => alias.startsWith(want)));
	if (loose.length === 1) return { topic: loose[0] };
	const ranked = base.topics
		.map((topic) => ({ id: topic.id, score: Math.min(distance(want, topic.id), ...topic.aliases.map((alias) => distance(want, alias))) - (loose.includes(topic) ? 10 : 0) }))
		.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
	return { suggestions: ranked.slice(0, 3).map((entry) => entry.id) };
}

/** A section by its name, slug, a unique prefix of either, or its number (1-based). */
export function resolveSection(topic: KnowledgeTopic, asked: string | number): KnowledgeSection | null {
	if (typeof asked === "number" || /^\d+$/.test(String(asked).trim())) {
		const index = Number(asked) - 1;
		return topic.sections[index] ?? null;
	}
	const want = slugify(String(asked));
	if (!want) return null;
	const exact = topic.sections.find((section) => section.slug === want);
	if (exact) return exact;
	const loose = topic.sections.filter((section) => section.slug.startsWith(want) || section.slug.includes(want));
	return loose.length === 1 ? loose[0] : null;
}

export interface IndexEntry {
	topic: string;
	title: string;
	read_when: string;
	sections: string[];
}

export function knowledgeIndex(base: KnowledgeBase): IndexEntry[] {
	return base.topics.map((topic) => ({ topic: topic.id, title: topic.title, read_when: topic.readWhen, sections: topic.sections.map((section) => section.name) }));
}

export interface SearchHit {
	topic: string;
	section: string | null;
	score: number;
	snippet: string;
}

/** Where the query's words are covered: sections ranked by word hits (heading and topic names count more). */
export function searchKnowledge(base: KnowledgeBase, query: string, limit: number = KNOWLEDGE_LIMITS.searchHits): SearchHit[] {
	const words = Array.from(new Set(query.toLowerCase().split(/[^a-z0-9%.]+/).filter((word) => word.length >= 2)));
	if (!words.length) return [];
	const hits: SearchHit[] = [];
	for (const topic of base.topics) {
		const topicWords = `${topic.id} ${topic.title} ${topic.aliases.join(" ")}`.toLowerCase();
		for (const section of topic.sections) {
			const text = section.text.toLowerCase();
			const head = section.name.toLowerCase();
			let score = 0;
			let matched = 0;
			for (const word of words) {
				const count = text.split(word).length - 1;
				const bonus = (head.includes(word) ? 3 : 0) + (topicWords.includes(word) ? 2 : 0);
				if (count || bonus) matched++;
				score += Math.min(count, 6) + bonus;
			}
			if (!score) continue;
			score += matched * 4; // every word found beats one word found many times
			const found = words.map((word) => text.indexOf(word)).filter((index) => index >= 0);
			const at = found.length ? Math.min(...found) : 0;
			const from = Math.max(0, at - 60);
			const raw = section.text.slice(from, from + KNOWLEDGE_LIMITS.snippetChars).replace(/\s+/g, " ").trim();
			hits.push({ topic: topic.id, section: section.name, score, snippet: `${from > 0 ? "…" : ""}${raw}${from + KNOWLEDGE_LIMITS.snippetChars < section.text.length ? "…" : ""}` });
		}
	}
	return hits.sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic)).slice(0, limit);
}
