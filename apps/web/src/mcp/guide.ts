/**
 * MCP `guide` (hf-skills agent, wave 7, 2026-10-24; plan/INBOX I-8, I-10): RestorffCut's craft playbooks, one topic per
 * call, so any model (a smaller one, another vendor's) learns when and how to use the tools well from the server, not
 * from its own memory. Files: packages/compositions/knowledge/*.md (adapted from HyperFrames' skills, Apache-2.0);
 * loader: ../server/knowledge.ts. Answers stay small: the index, one topic (≤ 12,000 chars of text), one section
 * (≤ 6,000) or ≤ 8 search hits — never everything at once.
 *
 *   guide {}                          the topic index (id, title, when to read it, its sections)
 *   guide {topic}                     one playbook (id, alias or a close word: "gsap" → animation-runtimes)
 *   guide {topic, section}            one `##` section of it (name, slug, a prefix, or its number)
 *   guide {query}                     where words are covered: topic + section + snippet
 * Runbook: packages/compositions/knowledge/README.md · worklog docs/restorff/worklog/hf-skills.md.
 */
import { type KnowledgeBase, type KnowledgeTopic, knowledgeIndex, loadKnowledge, resolveSection, resolveTopic, searchKnowledge } from "@/server/knowledge";
import { fail, type JsonSchema, type Payload, type Tool, type ToolOutput } from "./protocol";

const str = (description: string): JsonSchema => ({ type: "string", description });

/** Topic ids for the description, read once at load (the index itself is always read fresh). */
function topicIdsForDescription(): string {
	try {
		const ids = loadKnowledge().topics.map((topic) => topic.id);
		return ids.length ? ids.join(", ") : "workflow, story, composition-authoring, …";
	} catch {
		return "workflow, story, composition-authoring, …";
	}
}

const indexNext = (base: KnowledgeBase): Payload => {
	const first = base.topics.find((topic) => topic.id === "workflow") ?? base.topics[0];
	return first
		? { do: `Read the playbook for the job at hand (on a new video: ${first.id}).`, tool: "guide", arguments: { topic: first.id } }
		: { do: "No playbooks are installed on this server; work from the tools' own descriptions.", tool: "timeline", arguments: { action: "list" } };
};

/** After reading a topic: do the work with the tool it names; else the first related topic. */
function topicNext(topic: KnowledgeTopic): Payload {
	if (topic.next) {
		return {
			do: topic.next.do,
			tool: topic.next.tool,
			arguments: topic.next.action ? { action: topic.next.action } : {},
			...(topic.related.length ? { also_read: topic.related.slice(0, 3).map((id) => ({ tool: "guide", arguments: { topic: id } })) } : {}),
		};
	}
	return topic.related[0] ? { do: "Read the related playbook.", tool: "guide", arguments: { topic: topic.related[0] } } : { do: "List the playbooks.", tool: "guide", arguments: {} };
}

function indexAnswer(base: KnowledgeBase): ToolOutput {
	return {
		payload: {
			playbooks: base.topics.length,
			how: "guide {topic} reads one playbook; guide {topic, section} one section of it (name or number); guide {query} finds where words are covered. One topic per call.",
			topics: knowledgeIndex(base),
			credit: "Adapted from HyperFrames' agent skills and docs (HeyGen, Apache-2.0, commit fa5dbd1), rewritten for RestorffCut's tools.",
			next: indexNext(base),
		},
	};
}

function topicAnswer(topic: KnowledgeTopic, sectionAsked: unknown): ToolOutput {
	const sections = topic.sections.map((section, index) => `${index + 1}. ${section.name}`);
	if (sectionAsked !== undefined && sectionAsked !== null && String(sectionAsked).trim() !== "") {
		const section = resolveSection(topic, typeof sectionAsked === "number" ? sectionAsked : String(sectionAsked));
		if (!section) {
			const out = fail("unknown_section", `"${topic.id}" has no section "${String(sectionAsked)}". Ask for one of its sections by name or number, or for the whole topic without section.`, { topic: topic.id, sections });
			(out.payload as Payload).next = { do: "Read the whole playbook (it is small) or one of its sections.", tool: "guide", arguments: { topic: topic.id } };
			return out;
		}
		const at = topic.sections.indexOf(section);
		const following = topic.sections[at + 1];
		return {
			payload: {
				topic: topic.id,
				title: topic.title,
				section: section.name,
				text: section.text,
				sections,
				credit: topic.lead.split("\n").filter((line) => line.startsWith("Adapted from") || line.includes("RestorffCut's own")).join(" "),
				next: following ? { do: "Read the next section, or act on this one.", tool: "guide", arguments: { topic: topic.id, section: following.name } } : topicNext(topic),
			},
		};
	}
	return {
		payload: {
			topic: topic.id,
			title: topic.title,
			summary: topic.summary,
			read_when: topic.readWhen,
			tools: topic.tools,
			related: topic.related,
			sections,
			text: topic.body,
			next: topicNext(topic),
		},
	};
}

function searchAnswer(base: KnowledgeBase, query: string): ToolOutput {
	const hits = searchKnowledge(base, query);
	return {
		payload: {
			query,
			hits,
			next: hits[0]
				? { do: "Read the best match.", tool: "guide", arguments: { topic: hits[0].topic, ...(hits[0].section ? { section: hits[0].section } : {}) } }
				: { do: "Nothing matched those words: read the index and pick a topic.", tool: "guide", arguments: {} },
		},
	};
}

export const GUIDE_TOOL: Tool = {
	name: "guide",
	title: "Playbooks: how to make it good",
	description:
		"RestorffCut's craft playbooks: when and how to use the tools so a video holds attention and looks made by a professional (story and hook, motion, transitions, type and layout, captions, pacing and retention, sound, grade, numbers and charts, video types, writing compositions, animation runtimes, the look-check-fix loop). " +
		`Topics: ${topicIdsForDescription()}. ` +
		"guide {} = the index (each topic, when to read it, its sections); guide {topic} = one playbook (aliases work: \"gsap\", \"captions\", \"retention\"); guide {topic, section} = one section (name or number); guide {query: \"whip\"} = where words are covered. " +
		"Read 'workflow' on a new video, 'composition-authoring' before writing a composition, 'qa-loop' before judging a render. Answers are small: one topic per call. Read-only.",
	inputSchema: {
		type: "object",
		properties: {
			topic: str("A playbook id from the index (or an alias / close word). Omit for the index."),
			section: { type: ["string", "number"], description: "With topic: one section, by its name (or a unique part of it) or its number from `sections`." },
			query: str("Words to find across all playbooks (e.g. \"whip transition\", \"count-up\", \"text behind\"). Answers topic + section + snippet."),
		},
		additionalProperties: false,
	},
	annotations: { readOnlyHint: true, openWorldHint: false },
	run(args) {
		const base = loadKnowledge();
		if (!base.topics.length) return fail("no_playbooks", "No playbooks are installed on this server (packages/compositions/knowledge is missing or empty).", { problems: base.problems.slice(0, 5) });
		const topicAsked = typeof args.topic === "string" ? args.topic.trim() : "";
		const query = typeof args.query === "string" ? args.query.trim() : "";
		if (topicAsked) {
			const found = resolveTopic(base, topicAsked);
			if ("topic" in found) return topicAnswer(found.topic, args.section);
			const out = fail("unknown_topic", `No playbook "${topicAsked}". Did you mean: ${found.suggestions.join(", ") || "(none close)"}?`, {
				did_you_mean: found.suggestions,
				topics: base.topics.map((topic) => topic.id),
			});
			(out.payload as Payload).next = found.suggestions[0]
				? { do: "Read the closest playbook, or the index.", tool: "guide", arguments: { topic: found.suggestions[0] } }
				: { do: "Read the index.", tool: "guide", arguments: {} };
			return out;
		}
		if (query) return searchAnswer(base, query);
		return indexAnswer(base);
	},
};

/** The server-instructions line (tools.ts SERVER_INSTRUCTIONS). */
export const GUIDE_INSTRUCTIONS =
	"How to make it good, not just possible: the guide tool serves RestorffCut's craft playbooks one topic at a time (guide {} = the index). Read guide {topic: \"workflow\"} at the start of a new video, guide {topic: \"composition-authoring\"} before writing a composition, guide {topic: \"captions\"} / \"sound\" / \"transitions\" / \"pacing-retention\" before that kind of work, and guide {topic: \"qa-loop\"} before judging a render.";
