// Curated "popular models" shortlist for the interactive picker. Instead of scrolling OpenRouter's
// hundreds of ids, we surface the newest model per popular family. Ids come from the LIVE model list
// (whatever the connected backend/provider offers) so a chosen id is always valid — we only decide
// WHICH of the live ids to feature and in what order.

/** Popular families, in display order (the ones the user asked for first). `re` matches an id. */
export const POPULAR: Array<{ label: string; re: RegExp }> = [
  { label: "Claude Opus", re: /opus/i },
  { label: "Claude Fable", re: /fable/i },
  { label: "Grok", re: /grok/i },
  { label: "Qwen", re: /qwen/i },
  { label: "Kimi", re: /kimi/i },
  { label: "DeepSeek", re: /deepseek/i },
  { label: "Gemini", re: /gemini/i },
  { label: "GPT", re: /gpt|openai\/o\d/i },
];

/** Natural-order compare: split into text/number chunks and compare numerically where both are numbers.
 *  The model VERSION appears early in an id (before param counts and date stamps), so sorting the whole
 *  id this way ranks e.g. `grok-4` > `grok-2-1212`, `opus-4.8` > `opus-4.1-20240501`, `qwen3` > `qwen2.5`. */
export function naturalCmp(a: string, b: string): number {
  // Normalize so the version lands in a consistent token position across naming schemes: split fused
  // letter→digit runs (`qwen3` → `qwen 3`) and flatten separators (`-_/` → space), so `qwen3` and
  // `qwen-2.5` compare as `qwen 3` vs `qwen 2.5` (number vs number) instead of as differing text.
  const norm = (s: string): string => s.toLowerCase().replace(/([a-z])(\d)/g, "$1 $2").replace(/[-_/]+/g, " ");
  const ax = norm(a).match(/\d+\.?\d*|\D+/g) ?? [];
  const bx = norm(b).match(/\d+\.?\d*|\D+/g) ?? [];
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const as = ax[i] ?? "", bs = bx[i] ?? "";
    const an = parseFloat(as), bn = parseFloat(bs);
    if (!isNaN(an) && !isNaN(bn)) {
      if (an !== bn) return an - bn;
    } else if (as !== bs) {
      return as < bs ? -1 : 1;
    }
  }
  return 0;
}

/** Newest live id per popular family (natural-order "latest"), deduped, in display order. Families with
 *  no live match are skipped — we can't feature a model the backend doesn't actually serve. */
export function popularModels(ids: string[]): Array<{ label: string; id: string }> {
  const out: Array<{ label: string; id: string }> = [];
  const seen = new Set<string>();
  // Prefer a concrete, pinned id over an alias: `~vendor/model` and `…-latest`/`…-auto` ids resolve
  // to *something* server-side (the very ambiguity that made a `~kimi-latest` pick answer as Claude),
  // so feature a real versioned id when one exists; fall back to the alias only if that's all there is.
  const isAlias = (id: string): boolean => id.startsWith("~") || /[-/:](latest|auto)$/.test(id.toLowerCase());
  for (const fam of POPULAR) {
    const matches = ids.filter((id) => fam.re.test(id));
    const concrete = matches.filter((id) => !isAlias(id));
    const best = (concrete.length ? concrete : matches).sort((a, b) => naturalCmp(b, a))[0];
    if (best && !seen.has(best)) {
      seen.add(best);
      out.push({ label: fam.label, id: best });
    }
  }
  return out;
}
