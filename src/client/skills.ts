// Skills: SKILL.md files in .ada/skills/<name>/SKILL.md (or .ada/skills/<name>.md), project or
// global. Their name+description are advertised to the model; a `use_skill` tool returns the full
// instructions on demand, so the model pulls in specialized guidance only when it needs it.

import { existsSync, readFileSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { registerTool } from "./tools.ts";

export interface Skill {
  name: string;
  description: string;
  path: string;
}

function skillDirs(includeProject: boolean): string[] {
  const global = resolve(homedir(), ".ada", "skills");
  return includeProject ? [resolve(process.cwd(), ".ada", "skills"), global] : [global];
}

function frontDescription(md: string): string | undefined {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  return m?.[1]?.match(/description:\s*(.*)/)?.[1]?.trim();
}

export function loadSkills(includeProject: boolean): Skill[] {
  const skills: Skill[] = [];
  for (const dir of skillDirs(includeProject)) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const nested = join(dir, entry, "SKILL.md");
      const flat = join(dir, entry);
      const file = existsSync(nested) ? nested : entry.endsWith(".md") && existsSync(flat) && statSync(flat).isFile() ? flat : null;
      if (!file) continue;
      const name = entry.replace(/\.md$/, "");
      if (skills.some((s) => s.name === name)) continue; // project wins over global
      try {
        skills.push({ name, description: frontDescription(readFileSync(file, "utf8")) ?? "(no description)", path: file });
      } catch {
        /* ignore */
      }
    }
  }
  return skills;
}

/** Register a `use_skill` tool that returns a skill's full instructions on demand. */
export function registerSkillTool(skills: Skill[]): void {
  if (!skills.length) return;
  const byName = new Map(skills.map((s) => [s.name, s]));
  registerTool({
    name: "use_skill",
    description: `Load a skill's full instructions before a specialized task. Available: ${skills.map((s) => `${s.name} — ${s.description}`).join("; ")}`,
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    needsApproval: false,
    async run(args) {
      const s = byName.get(String(args.name));
      if (!s) return { output: `Unknown skill: ${String(args.name)}. Available: ${[...byName.keys()].join(", ")}`, isError: true };
      try {
        return { output: readFileSync(s.path, "utf8") };
      } catch (e) {
        return { output: String(e), isError: true };
      }
    },
  });
}
