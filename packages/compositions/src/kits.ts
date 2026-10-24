// Library kits (composition-v3, 2026-10-21): shared code several LIBRARY compositions use, written once in
// kits/<name>.js (+ optional kits/<name>.css). A library composition names its kit in the params block
// (`"kit": "neon-grid"`) and keeps the `<!-- rc-kit -->` marker in its <head>; the renderer then runs the kit right
// after the runtime, before the page's own scripts (render.ts initScript), and the kit's sha is part of that
// composition's render hash only (a kit fix re-renders exactly the pieces that use it).
//
// The same code serves custom compositions: MCP `composition kit {timeline_id, library_kit: "neon-grid"}` makes it the
// timeline's kit, so a library piece forked as custom code (`composition update {source}`) renders unchanged.
// CONTRACT.md §9c.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// computed here, not imported from render.ts (render.ts imports this module: a cycle would leave it undefined)
export const KITS_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "kits");
const KIT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface LibraryKit {
  name: string;
  /** The kit's JavaScript (defines helpers; never calls RC.composition). */
  js: string;
  /** Optional shared CSS (kits/<name>.css). */
  css?: string;
  /** sha256 of js + "\n/*css*\/\n" + css: what goes in a render hash. */
  sha: string;
  bytes: number;
  /** The first comment block of the .js file, without the comment markers (what the kit is for). */
  description: string;
}

export function isKitName(name: unknown): name is string {
  return typeof name === "string" && KIT_NAME.test(name);
}

/** A library kit by name, or null when there is none. Names are kebab-case ids (no paths). */
export function readLibraryKit(name: string): LibraryKit | null {
  if (!isKitName(name)) return null;
  const jsFile = join(KITS_DIR, `${name}.js`);
  if (!existsSync(jsFile)) return null;
  const js = readFileSync(jsFile, "utf8");
  const cssFile = join(KITS_DIR, `${name}.css`);
  const css = existsSync(cssFile) ? readFileSync(cssFile, "utf8") : undefined;
  const body = css ? `${js}\n/*css*/\n${css}` : js;
  const head = /^\s*\/\*([\s\S]*?)\*\//.exec(js)?.[1] ?? "";
  const description = head
    .split("\n")
    .map((line) => line.replace(/^\s*-{3,}\s*$/, "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
  return { name, js, ...(css ? { css } : {}), sha: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body, "utf8"), description };
}

/** Every library kit (kits/*.js). */
export function listLibraryKits(): LibraryKit[] {
  if (!existsSync(KITS_DIR)) return [];
  return readdirSync(KITS_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => readLibraryKit(f.slice(0, -3)))
    .filter((k): k is LibraryKit => k !== null);
}

/** The script the renderer appends after the runtime for a library composition that names a kit. */
export function kitInitScript(kit: LibraryKit): string {
  const css = kit.css
    ? `\n;(function(){var s=document.createElement("style");s.setAttribute("data-rc-kit","${kit.name}");s.textContent=${JSON.stringify(kit.css)};` +
      `var add=function(){(document.head||document.documentElement).appendChild(s);};if(document.documentElement)add();else document.addEventListener("DOMContentLoaded",add,{once:true});})();`
    : "";
  return `\n;/* rc-kit ${kit.name} */\n${kit.js}${css}\n`;
}
