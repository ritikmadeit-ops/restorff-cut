// The starter library: compositions/<name>/<name>.html + <name>.props.json (example props, fictional Halcyon content).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "./params.ts";
import { PKG_ROOT } from "./render.ts";

export const LIBRARY_DIR = join(PKG_ROOT, "compositions");
export const SAMPLES_DIR = join(PKG_ROOT, "samples");

export interface LibraryEntry {
  name: string;
  title: string;
  description: string;
  tags: string[];
  duration: number;
  size: [number, number];
  html: string;
  /** Example props file, if present. */
  props: string | null;
  /** Rendered sample (.webm) path — may not exist yet. */
  sample: string;
}

export function listLibrary(): LibraryEntry[] {
  if (!existsSync(LIBRARY_DIR)) return [];
  const out: LibraryEntry[] = [];
  for (const name of readdirSync(LIBRARY_DIR).sort()) {
    const html = join(LIBRARY_DIR, name, `${name}.html`);
    if (!existsSync(html)) continue;
    const m = parseManifest(readFileSync(html, "utf8"));
    const props = join(LIBRARY_DIR, name, `${name}.props.json`);
    out.push({
      name: m.name,
      title: m.title,
      description: m.description,
      tags: m.tags ?? [],
      duration: m.duration,
      size: m.size,
      html,
      props: existsSync(props) ? props : null,
      sample: join(SAMPLES_DIR, `${name}.webm`),
    });
  }
  return out;
}
