// Skill routing: rank skills by relevance to a free-text request, so ada can surface the right
// skill proactively (or via the find_skill tool) instead of the model browsing the whole catalog.
//
// ponytail: this is a lexical TF-IDF-ish ranker (idf-weighted token overlap, name-boosted, with a
// shared-prefix match so plurals/derivations line up — "docker" ↔ "dockerfile", "migrate" ↔
// "migration"). No embedding model or dependency. A real embedding scorer can replace `rankSkills`
// later if synonym matching (e.g. "containerize" → dockerize) becomes worth a model round-trip.

export interface RankItem {
  name: string;
  description: string;
  category?: string;
}

const STOP = new Set(
  "a an and are as at be build by can create do for from how in into is it make of on or set the this to up use using with without your you".split(" "),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Two tokens match if equal or they share a 4+ char prefix (a cheap stand-in for stemming). */
function matches(a: string, b: string): boolean {
  if (a === b) return true;
  const m = Math.min(a.length, b.length);
  let i = 0;
  while (i < m && a[i] === b[i]) i++;
  return i >= 4;
}

/** Top-n skills most relevant to `query`, scored by idf-weighted token overlap (name-boosted). */
export function rankSkills(query: string, items: RankItem[], n = 5): { name: string; description: string; score: number }[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !items.length) return [];
  const docs = items.map((it) => ({
    name: tokenize(it.name),
    all: tokenize(`${it.name} ${it.description} ${it.category ?? ""}`),
  }));
  const N = items.length;
  const idf = (qt: string): number => {
    let df = 0;
    for (const d of docs) if (d.all.some((dt) => matches(qt, dt))) df++;
    return Math.log(1 + N / (1 + df));
  };
  const weight = new Map(q.map((qt) => [qt, idf(qt)]));
  const scored = items.map((it, i) => {
    let s = 0;
    for (const qt of q) {
      if (docs[i].all.some((dt) => matches(qt, dt))) {
        s += weight.get(qt)! * (docs[i].name.some((dt) => matches(qt, dt)) ? 2.5 : 1);
      }
    }
    return { name: it.name, description: it.description, score: s };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

/**
 * The single clearly-dominant skill for a query, or null when the match is weak/ambiguous.
 * Three gates, all required: a score floor, dominance over the runner-up, and — crucially — an
 * EXACT whole-token overlap with the skill NAME. That last gate is the precision guard against
 * lexical false positives: "make a powerpoint" prefix-matches "low-power" and even dominates, but
 * "powerpoint" never equals the name token "power", so it's correctly rejected.
 */
export function confidentSkill(query: string, items: RankItem[]): string | null {
  const ranked = rankSkills(query, items, 2);
  const top = ranked[0];
  if (!top || top.score < 4) return null;
  if (ranked[1] && top.score < ranked[1].score * 1.3) return null; // reject ties/near-ties; the name-exact gate below is the real precision guard
  const q = new Set(tokenize(query));
  return tokenize(top.name).some((t) => q.has(t)) ? top.name : null;
}
