// User prompt templates ("/commands"). Markdown files in .ada/prompts/ (project) or
// ~/.ada/prompts/ (global) become slash commands: a file `review.md` → `/review <args>`.
// Substitutions: $ARGUMENTS (everything after the command), $1, $2, … (whitespace-split args).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

function dirs(includeProject: boolean): string[] {
  const global = resolve(homedir(), ".ada", "prompts");
  return includeProject ? [resolve(process.cwd(), ".ada", "prompts"), global] : [global];
}

export function loadPrompts(includeProject = true): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of dirs(includeProject)) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) {
      if (!f.endsWith(".md")) continue;
      const name = basename(f, ".md");
      if (out.has(name)) continue; // project dir wins over global
      try {
        out.set(name, readFileSync(join(dir, f), "utf8"));
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

/** If `input` is `/<name> args` and a template exists, return the expanded text; else null. */
export function expandPrompt(prompts: Map<string, string>, input: string): string | null {
  if (!input.startsWith("/")) return null;
  const name = input.slice(1).split(/\s+/)[0] ?? "";
  const tmpl = prompts.get(name);
  if (!tmpl) return null;
  const argline = input.slice(1 + name.length).trim();
  const parts = argline ? argline.split(/\s+/) : [];
  return tmpl.replace(/\$ARGUMENTS/g, argline).replace(/\$(\d+)/g, (_, n) => parts[Number(n) - 1] ?? "");
}
