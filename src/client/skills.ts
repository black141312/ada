// Skills: SKILL.md files in .ada/skills/<name>/SKILL.md (or .ada/skills/<name>.md), project or
// global, plus the ones bundled with ada. A `list_skills` tool lets the model browse them on demand
// (so the per-request tool surface stays small even with hundreds of skills); `use_skill` then
// returns the full instructions for one by name.

import { existsSync, readFileSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerTool } from "./tools.ts";
import { rankSkills } from "./skill-router.ts";

let LOADED: Skill[] = []; // the skills registered this session — for routeSkills()

/** Rank the loaded skills by relevance to a request (used by find_skill + the agent's auto-suggest). */
export function routeSkills(query: string, n = 5): { name: string; description: string; score: number }[] {
  return rankSkills(query, LOADED, n);
}

// Skills bundled with ada (committed, shipped). src/client/skills.ts → <package>/skills.
const BUNDLED = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

export interface Skill {
  name: string;
  description: string;
  path: string;
  category?: string;
}

function skillDirs(includeProject: boolean): string[] {
  const global = resolve(homedir(), ".ada", "skills");
  // Precedence (first match wins): project → global → bundled built-ins.
  return includeProject ? [resolve(process.cwd(), ".ada", "skills"), global, BUNDLED] : [global, BUNDLED];
}

/** Read one `key: value` line from a SKILL.md's `---` front-matter. */
function frontField(md: string, key: string): string | undefined {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  return m?.[1]?.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]?.trim();
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
      if (skills.some((s) => s.name === name)) continue; // project wins over global wins over bundled
      try {
        const md = readFileSync(file, "utf8");
        skills.push({ name, description: frontField(md, "description") ?? "(no description)", path: file, category: frontField(md, "category") });
      } catch {
        /* ignore */
      }
    }
  }
  return skills;
}

/** Register `list_skills` (browse on demand) + `use_skill` (load one's full instructions). */
export function registerSkillTool(skills: Skill[]): void {
  if (!skills.length) return;
  LOADED = skills;
  const byName = new Map(skills.map((s) => [s.name, s]));
  const catOf = (s: Skill): string => s.category ?? "other";

  registerTool({
    name: "find_skill",
    description: "Find the skills most relevant to a task, ranked. Better than list_skills' substring filter for fuzzy matches. Returns the top matches; load one with use_skill.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    needsApproval: false,
    async run(args) {
      const ranked = routeSkills(String(args.query ?? ""), 8);
      if (!ranked.length) return { output: "No relevant skills found. Try list_skills for the full catalog." };
      return { output: ranked.map((r) => `- ${r.name} — ${r.description}`).join("\n") };
    },
  });

  registerTool({
    name: "list_skills",
    description:
      "Browse available skills. Optional `category` to list one category, or `filter` substring to search names + descriptions. With no args, returns the categories and their counts. Then load one with use_skill.",
    parameters: { type: "object", properties: { category: { type: "string" }, filter: { type: "string" } }, additionalProperties: false },
    needsApproval: false,
    async run(args) {
      const cat = args.category ? String(args.category).toLowerCase() : "";
      const filt = args.filter ? String(args.filter).toLowerCase() : "";
      if (!cat && !filt) {
        const counts = new Map<string, number>();
        for (const s of skills) counts.set(catOf(s), (counts.get(catOf(s)) ?? 0) + 1);
        const lines = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, n]) => `${c} (${n})`);
        return { output: `${skills.length} skills across ${counts.size} categories. Pass {category} or {filter} to list them.\n${lines.join(" · ")}` };
      }
      let matched = skills;
      if (cat) matched = matched.filter((s) => catOf(s).toLowerCase() === cat);
      if (filt) matched = matched.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(filt));
      if (!matched.length) return { output: `No skills match${cat ? ` category=${cat}` : ""}${filt ? ` filter=${filt}` : ""}.` };
      const byCat = new Map<string, Skill[]>();
      for (const s of matched) {
        const c = catOf(s);
        const arr = byCat.get(c) ?? [];
        if (!byCat.has(c)) byCat.set(c, arr);
        arr.push(s);
      }
      const out = [...byCat.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([c, list]) => `## ${c}\n${list.map((s) => `- ${s.name} — ${s.description}`).join("\n")}`)
        .join("\n\n");
      return { output: out };
    },
  });

  registerTool({
    name: "use_skill",
    description: "Load a skill's full instructions by name before a specialized task. Call list_skills first to see what's available (~200 skills across many categories).",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    needsApproval: false,
    async run(args) {
      const s = byName.get(String(args.name));
      if (!s) return { output: `Unknown skill: ${String(args.name)}. Call list_skills to see available skills.`, isError: true };
      try {
        return { output: readFileSync(s.path, "utf8") };
      } catch (e) {
        return { output: String(e), isError: true };
      }
    },
  });
}
