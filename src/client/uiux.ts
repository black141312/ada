// UI/UX design lookup: BM25 over a bundled corpus of design rules — 84 styles, 192 colour
// palettes, 74 font pairings, 192 product types, 98 UX guidelines, motion presets, chart guidance
// and per-stack rules across 22 stacks.
//
// The corpus is vendored from github.com/nextlevelbuilder/ui-ux-pro-max-skill (MIT, see
// skills/ui-ux-pro-max/LICENSE.upstream). Upstream ships a Python CLI; this is a faithful port of
// its ranking so the skill has no runtime prerequisite — ada is already Node, and a bundled skill
// that needs Python installed is a skill that silently doesn't work for half its users.
// ponytail: no index on disk. 1.7MB of CSV parses in ~30ms and is cached per process; revisit only
// if the corpus grows an order of magnitude.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "ui-ux-pro-max", "data");
const MAX_RESULTS = 3;

interface DomainConfig {
  file: string;
  search: string[];
  output: string[];
}

export const DOMAINS: Record<string, DomainConfig> = {
  style: {
    file: "styles.csv",
    search: ["Style Category", "Keywords", "Best For", "Type", "AI Prompt Keywords"],
    output: ["Style Category", "Type", "Keywords", "Primary Colors", "Effects & Animation", "Best For", "Light Mode ✓", "Dark Mode ✓", "Performance", "Accessibility", "Framework Compatibility", "Complexity", "AI Prompt Keywords", "CSS/Technical Keywords", "Implementation Checklist", "Design System Variables"],
  },
  color: {
    file: "colors.csv",
    search: ["Product Type", "Notes"],
    output: ["Product Type", "Primary", "On Primary", "Secondary", "On Secondary", "Accent", "On Accent", "Background", "Foreground", "Card", "Card Foreground", "Muted", "Muted Foreground", "Border", "Destructive", "On Destructive", "Ring", "Notes"],
  },
  chart: {
    file: "charts.csv",
    search: ["Data Type", "Keywords", "Best Chart Type", "When to Use", "When NOT to Use", "Accessibility Notes"],
    output: ["Data Type", "Keywords", "Best Chart Type", "Secondary Options", "When to Use", "When NOT to Use", "Data Volume Threshold", "Color Guidance", "Accessibility Grade", "Accessibility Notes", "A11y Fallback", "Library Recommendation", "Interactive Level"],
  },
  landing: {
    file: "landing.csv",
    search: ["Pattern Name", "Keywords", "Conversion Optimization", "Section Order"],
    output: ["Pattern Name", "Keywords", "Section Order", "Primary CTA Placement", "Color Strategy", "Conversion Optimization"],
  },
  product: {
    file: "products.csv",
    search: ["Product Type", "Keywords", "Primary Style Recommendation", "Key Considerations"],
    output: ["Product Type", "Keywords", "Primary Style Recommendation", "Secondary Styles", "Landing Page Pattern", "Dashboard Style (if applicable)", "Color Palette Focus"],
  },
  ux: {
    file: "ux-guidelines.csv",
    search: ["Category", "Issue", "Description", "Platform"],
    output: ["Category", "Issue", "Platform", "Description", "Do", "Don't", "Code Example Good", "Code Example Bad", "Severity"],
  },
  typography: {
    file: "typography.csv",
    search: ["Font Pairing Name", "Category", "Mood/Style Keywords", "Best For", "Heading Font", "Body Font"],
    output: ["Font Pairing Name", "Category", "Heading Font", "Body Font", "Mood/Style Keywords", "Best For", "Google Fonts URL", "CSS Import", "Tailwind Config", "Notes"],
  },
  icons: {
    file: "icons.csv",
    search: ["Category", "Icon Name", "Keywords", "Best For"],
    output: ["Category", "Icon Name", "Keywords", "Library", "Import Code", "Usage", "Best For", "Style"],
  },
  gsap: {
    file: "motion.csv",
    search: ["Category", "Intensity Tier", "Keywords", "Trigger"],
    output: ["Category", "Intensity Tier", "Trigger", "Duration", "Easing", "GSAP Snippet", "Framework Notes", "Do", "Don't", "Performance Notes"],
  },
  react: {
    file: "react-performance.csv",
    search: ["Category", "Issue", "Keywords", "Description"],
    output: ["Category", "Issue", "Platform", "Description", "Do", "Don't", "Code Example Good", "Code Example Bad", "Severity"],
  },
  web: {
    file: "app-interface.csv",
    search: ["Category", "Issue", "Keywords", "Description"],
    output: ["Category", "Issue", "Platform", "Description", "Do", "Don't", "Code Example Good", "Code Example Bad", "Severity"],
  },
  "google-fonts": {
    file: "google-fonts.csv",
    search: ["Family", "Category", "Stroke", "Classifications", "Keywords", "Subsets", "Designers"],
    output: ["Family", "Category", "Stroke", "Classifications", "Styles", "Variable Axes", "Subsets", "Designers", "Popularity Rank", "Google Fonts URL"],
  },
};

const STACK_COLS = {
  search: ["Category", "Guideline", "Description", "Do", "Don't"],
  output: ["Category", "Guideline", "Description", "Do", "Don't", "Code Good", "Code Bad", "Severity", "Docs URL"],
};

/** Stacks are one file each under data/stacks — read the directory rather than hard-coding a list
 *  that drifts when the corpus is updated. */
export function availableStacks(): string[] {
  try {
    return readdirSync(join(DATA, "stacks"))
      .filter((f) => f.endsWith(".csv"))
      .map((f) => f.replace(/\.csv$/, ""))
      .sort();
  } catch {
    return [];
  }
}

const STOPWORDS = new Set("to in on at is of by or an if no so do be we it as the and for are was".split(" "));
const SYNONYMS: [string, string][] = [
  ["e-commerce", "ecommerce"], ["dark-mode", "dark"], ["darkmode", "dark"], ["light-mode", "light"],
  ["lightmode", "light"], ["a11y", "accessibility"], ["nav", "navigation"], ["sign-up", "signup"],
  ["log-in", "login"], ["colour", "color"], ["colours", "colors"], ["customisation", "customization"],
  ["organisation", "organization"], ["behaviour", "behavior"], ["ux/ui", "ux ui"],
];

function tokenize(text: string): string[] {
  let t = String(text).toLowerCase();
  for (const [from, to] of SYNONYMS) t = t.split(from).join(to);
  return t
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/** RFC4180-ish CSV: quoted fields may contain commas, newlines and "" escapes. Node has no CSV
 *  parser and the corpus is full of code snippets with both, so a split(',') would shred it. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows
    .filter((r) => r.some((v) => v !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

class BM25 {
  private readonly k1 = 1.5;
  private readonly b = 0.75;
  private lengths: number[] = [];
  private avgdl = 0;
  private idf = new Map<string, number>();
  private tf: Map<string, number>[] = [];
  private n = 0;

  constructor(documents: string[]) {
    const corpus = documents.map(tokenize);
    this.n = corpus.length;
    if (!this.n) return;
    this.lengths = corpus.map((d) => d.length);
    this.avgdl = this.lengths.reduce((a, b) => a + b, 0) / this.n;
    const df = new Map<string, number>();
    for (const doc of corpus) {
      const freq = new Map<string, number>();
      for (const w of doc) freq.set(w, (freq.get(w) ?? 0) + 1);
      this.tf.push(freq);
      for (const w of freq.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    }
    for (const [w, f] of df) this.idf.set(w, Math.log((this.n - f + 0.5) / (f + 0.5) + 1));
  }

  score(query: string): { idx: number; score: number }[] {
    const tokens = tokenize(query);
    const out: { idx: number; score: number }[] = [];
    for (let i = 0; i < this.n; i++) {
      let s = 0;
      for (const t of tokens) {
        const idf = this.idf.get(t);
        if (idf === undefined) continue;
        const tf = this.tf[i]!.get(t) ?? 0;
        s += (idf * (tf * (this.k1 + 1))) / (tf + this.k1 * (1 - this.b + (this.b * this.lengths[i]!) / this.avgdl));
      }
      out.push({ idx: i, score: s });
    }
    // stable descending sort: equal scores keep corpus order, as Python's sorted() does
    return out.sort((a, b) => b.score - a.score || a.idx - b.idx);
  }

  vocabulary(): string[] {
    return [...this.idf.keys()];
  }
}

const csvCache = new Map<string, Record<string, string>[]>();
const bmCache = new Map<string, BM25>();

function loadCsv(file: string): Record<string, string>[] {
  const hit = csvCache.get(file);
  if (hit) return hit;
  const p = join(DATA, file);
  if (!existsSync(p)) return [];
  const rows = parseCsv(readFileSync(p, "utf8"));
  csvCache.set(file, rows);
  return rows;
}

function index(file: string, cols: string[], rows: Record<string, string>[]): BM25 {
  const key = `${file}|${cols.join(",")}`;
  const hit = bmCache.get(key);
  if (hit) return hit;
  const bm = new BM25(rows.map((r) => cols.map((c) => r[c] ?? "").join(" ")));
  bmCache.set(key, bm);
  return bm;
}

/** Product keywords are read out of the corpus so domain detection stays in step with the data. */
let productKeywords: string[] | null = null;
function loadProductKeywords(): string[] {
  if (productKeywords) return productKeywords;
  const seed = ["saas", "ecommerce", "e-commerce", "fintech", "healthcare", "gaming", "portfolio", "crypto", "dashboard", "fitness", "marketplace"];
  const set = new Set(seed);
  for (const row of loadCsv(DOMAINS.product!.file)) {
    for (const kw of (row["Keywords"] ?? "").split(/[,;]/)) {
      const k = kw.trim().toLowerCase();
      if (k.length >= 3) set.add(k);
    }
  }
  productKeywords = [...set].sort((a, b) => b.length - a.length);
  return productKeywords;
}

const TIEBREAK = ["ux", "product", "style", "color", "typography", "google-fonts", "chart", "landing", "icons", "gsap", "react", "web"];

function domainKeywords(): Record<string, string[]> {
  return {
    color: ["color", "palette", "hex", "#", "rgb", "token", "semantic", "accent", "destructive", "muted", "foreground"],
    chart: ["chart", "graph", "visualization", "trend", "bar", "pie", "scatter", "heatmap", "funnel"],
    landing: ["landing", "page", "cta", "conversion", "hero", "testimonial", "pricing", "section"],
    product: loadProductKeywords(),
    style: ["style", "design", "ui", "minimalism", "glassmorphism", "neumorphism", "brutalism", "dark mode", "flat", "aurora", "prompt", "css", "implementation", "variable", "checklist", "tailwind"],
    ux: ["ux", "usability", "accessibility", "wcag", "touch", "scroll", "animation", "keyboard", "navigation", "mobile"],
    typography: ["font pairing", "typography pairing", "heading font", "body font"],
    "google-fonts": ["google font", "font family", "font weight", "font style", "variable font", "noto", "font for", "find font", "font subset", "font language", "monospace font", "serif font", "sans serif font", "display font", "handwriting font", "font", "typography", "serif", "sans"],
    icons: ["icon", "icons", "lucide", "heroicons", "symbol", "glyph", "pictogram", "svg icon"],
    gsap: ["gsap", "quickto", "scrolltrigger", "stagger", "magnetic cursor", "parallax", "page transition", "scroll reveal", "scroll-triggered", "scrollytelling", "flip plugin", "splittext", "shimmer", "skeleton loader"],
    react: ["react", "next.js", "nextjs", "suspense", "memo", "usecallback", "useeffect", "rerender", "bundle", "waterfall", "barrel", "dynamic import", "rsc", "server component"],
    web: ["aria", "focus", "outline", "semantic", "virtualize", "autocomplete", "form", "input type", "preconnect"],
  };
}

/** Which corpus a free-text question belongs to. Longer keyword phrases are more specific, so they
 *  score higher; ties resolve by a fixed order rather than object key order. */
export function detectDomain(query: string): { domain: string; runnerUp: string | null } {
  const q = query.toLowerCase();
  const scored: { domain: string; score: number }[] = [];
  for (const [domain, keywords] of Object.entries(domainKeywords())) {
    let total = 0;
    for (const kw of keywords) {
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "");
      if (re.test(q)) total += Math.max(1, kw.split(" ").length);
    }
    scored.push({ domain, score: total });
  }
  const rank = (d: string) => (TIEBREAK.includes(d) ? -TIEBREAK.indexOf(d) : -999);
  scored.sort((a, b) => b.score - a.score || rank(b.domain) - rank(a.domain));
  const best = scored[0]!;
  const runnerUp = scored[1] && scored[1].score > 0 ? scored[1].domain : null;
  return { domain: best.score > 0 ? best.domain : "style", runnerUp };
}

export interface UiuxResult {
  domain: string;
  stack?: string;
  query: string;
  file: string;
  count: number;
  results: Record<string, string>[];
  autoDetected?: boolean;
  runnerUpDomain?: string | null;
  suggestions?: string[];
  error?: string;
}

function run(file: string, searchCols: string[], outputCols: string[], query: string, max: number): { results: Record<string, string>[]; bm: BM25 | null } {
  const rows = loadCsv(file);
  if (!rows.length) return { results: [], bm: null };
  const bm = index(file, searchCols, rows);
  const results: Record<string, string>[] = [];
  for (const { idx, score } of bm.score(query).slice(0, max)) {
    if (score <= 0) continue;
    const row = rows[idx]!;
    const picked: Record<string, string> = {};
    for (const c of outputCols) if (c in row) picked[c] = row[c]!;
    results.push(picked);
  }
  return { results, bm };
}

/** Terms actually present in the corpus that share a prefix with the query — so a miss suggests a
 *  retry instead of reporting nothing. */
function suggest(bm: BM25 | null, query: string, limit = 6): string[] {
  if (!bm) return [];
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const vocab = bm.vocabulary();
  const out = new Set<string>();
  for (const t of tokens) {
    for (const v of vocab) {
      if (v !== t && (v.startsWith(t.slice(0, 4)) || t.startsWith(v.slice(0, 4)))) out.add(v);
      if (out.size >= limit) break;
    }
    if (out.size >= limit) break;
  }
  return [...out].slice(0, limit);
}

export function uiuxSearch(query: string, opts: { domain?: string; stack?: string; maxResults?: number } = {}): UiuxResult {
  const max = opts.maxResults ?? MAX_RESULTS;
  if (opts.stack) {
    const stacks = availableStacks();
    if (!stacks.includes(opts.stack)) return { domain: "stack", query, file: "", count: 0, results: [], error: `Unknown stack: ${opts.stack}. Available: ${stacks.join(", ")}` };
    const file = `stacks/${opts.stack}.csv`;
    const { results, bm } = run(file, STACK_COLS.search, STACK_COLS.output, query, max);
    return { domain: "stack", stack: opts.stack, query, file, count: results.length, results, ...(results.length ? {} : { suggestions: suggest(bm, query) }) };
  }
  const auto = !opts.domain;
  const { domain, runnerUp } = auto ? detectDomain(query) : { domain: opts.domain!, runnerUp: null };
  const config = DOMAINS[domain] ?? DOMAINS.style!;
  const { results, bm } = run(config.file, config.search, config.output, query, max);
  return {
    domain,
    query,
    file: config.file,
    count: results.length,
    results,
    ...(auto ? { autoDetected: true, runnerUpDomain: runnerUp } : {}),
    ...(results.length ? {} : { suggestions: suggest(bm, query) }),
  };
}

/** Flatten a result into something a model reads well — long code/checklist fields stay whole. */
export function renderUiux(r: UiuxResult): string {
  if (r.error) return r.error;
  const head = `${r.stack ? `stack: ${r.stack}` : `domain: ${r.domain}${r.autoDetected ? " (auto-detected)" : ""}`} · ${r.file} · ${r.count} result${r.count === 1 ? "" : "s"}`;
  if (!r.count) {
    return `${head}\nNothing matched "${r.query}".${r.suggestions?.length ? ` Try: ${r.suggestions.join(", ")}` : ""}`;
  }
  const body = r.results
    .map((row, i) => `\n### ${i + 1}\n${Object.entries(row).filter(([, v]) => v).map(([k, v]) => `- **${k}:** ${v}`).join("\n")}`)
    .join("\n");
  const also = r.runnerUpDomain ? `\n\n(also relevant: domain "${r.runnerUpDomain}")` : "";
  return `${head}${body}${also}`;
}
