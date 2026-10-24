// knowledge/ (hf-skills agent, 2026-10-24): the playbooks' worked composition must validate as the renderer would
// validate it, and every playbook keeps its credit line and front matter. The serving side (MCP `guide`) is tested in
// apps/web/src/server/__tests__/knowledge.test.ts. Run: cd packages/compositions && bun test test/knowledge.test.ts
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateCustom } from "../src/custom.ts";

const DIR = join(import.meta.dir, "..", "knowledge");
const topics = readdirSync(DIR).filter((f) => f.endsWith(".md") && f !== "README.md");

/** The first fenced block of a language after a `## ` heading. */
function fenced(text: string, heading: string, lang: string): string {
  const at = text.indexOf(`\n## ${heading}`);
  if (at < 0) throw new Error(`no section "${heading}"`);
  const m = new RegExp("```" + lang + "\\r?\\n([\\s\\S]*?)\\r?\\n```").exec(text.slice(at));
  if (!m) throw new Error(`no ${lang} block under "${heading}"`);
  return m[1];
}

describe("knowledge playbooks", () => {
  test("at least 14 topics, each with front matter and a credit line", () => {
    expect(topics.length).toBeGreaterThanOrEqual(14);
    for (const file of topics) {
      const text = readFileSync(join(DIR, file), "utf8");
      expect(text.startsWith("---\n") || text.startsWith("---\r\n")).toBe(true);
      expect(text).toContain(`id: ${file.replace(/\.md$/, "")}`);
      expect(text).toMatch(/Adapted from HyperFrames|RestorffCut's own/);
    }
  });

  test("no third-party platform names in the playbooks", () => {
    const marks = /\b(TikTok|Instagram|YouTube|Twitter|ChatGPT|OpenAI|Anthropic|Claude|GitHub|Apple|macOS|iPhone|Figma|Remotion|HeyGen voice|McKinsey|WIRED|Penguin|Spotify)\b/;
    for (const file of topics) {
      const body = readFileSync(join(DIR, file), "utf8").replace(/^---[\s\S]*?\n---\n/, "");
      const hit = marks.exec(body);
      expect(hit ? `${file}: ${hit[0]}` : null).toBeNull();
    }
  });

  test("composition-example's source validates with its props (what composition write would accept)", () => {
    const text = readFileSync(join(DIR, "composition-example.md"), "utf8");
    const source = fenced(text, "The source", "html");
    const props = JSON.parse(fenced(text, "Props and the call", "json"));
    const v = validateCustom(source, props);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.protocol).toBe("rc");
    expect(v.warnings).toEqual([]);
    expect(Object.keys(v.manifest?.params ?? {}).sort()).toEqual(["accent", "beats", "highlight", "scale", "speed"]);
  });
});
