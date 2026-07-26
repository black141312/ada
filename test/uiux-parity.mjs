// The UI/UX corpus shipped with a Python search CLI; ada runs a Node port of it so the skill has no
// runtime prerequisite. A port is only worth having if it ranks the same, so this diffs the two
// implementations over a spread of queries and fails on any disagreement.
//
// Needs python3 + the upstream checkout to compare against; without them it verifies the Node side
// alone (shape, determinism, domain routing) and says the parity half was skipped.
//   run: node --import tsx test/uiux-parity.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { uiuxSearch, detectDomain, availableStacks, parseCsv } = await import(
  pathToFileURL(resolve("src/client/uiux.ts")).href
);

const UPSTREAM =
  "C:/Users/ADMIN/AppData/Local/Temp/claude/C--Users-ADMIN-Desktop-ada-app/5de8bbcc-01cc-415a-8962-37d56fea59ce/scratchpad/uiux/.claude/skills/ui-ux-pro-max";

const QUERIES = [
  "dashboard for a fintech saas",
  "colour palette for a healthcare app",
  "font pairing for an editorial site",
  "which chart for a time series",
  "accessible touch targets on mobile",
  "glassmorphism dark mode",
  "landing page conversion",
  "scroll triggered animation",
  "icons for a settings screen",
  "react rerender performance",
];

// --- the Node side must be sane on its own -------------------------------------------------
for (const q of QUERIES) {
  const r = uiuxSearch(q);
  assert.ok(r.domain, `no domain for "${q}"`);
  assert.ok(Array.isArray(r.results), `no results array for "${q}"`);
  assert.ok(r.count <= 3, `more than max results for "${q}"`);
  if (r.count)
    assert.ok(Object.keys(r.results[0]).length > 0, `empty row for "${q}"`);
}

// deterministic: the same query twice gives the same answer
const a = uiuxSearch("dashboard for a fintech saas");
const b = uiuxSearch("dashboard for a fintech saas");
assert.deepEqual(a.results, b.results, "search is not deterministic");

// an explicit domain overrides detection
assert.equal(
  uiuxSearch("anything at all", { domain: "color" }).domain,
  "color",
);
assert.equal(
  uiuxSearch("anything at all", { domain: "color" }).autoDetected,
  undefined,
);

// stacks are discovered from the corpus, and a bad one reports itself
const stacks = availableStacks();
assert.ok(
  stacks.length >= 20,
  `expected the stack corpus, got ${stacks.length}`,
);
assert.ok(
  stacks.includes("react") && stacks.includes("flutter"),
  `stack list looks wrong: ${stacks}`,
);
assert.match(
  uiuxSearch("buttons", { stack: "nope" }).error ?? "",
  /Unknown stack/,
);
assert.ok(
  uiuxSearch("state management", { stack: "flutter" }).count > 0,
  "stack search returned nothing",
);

// a miss suggests real vocabulary instead of silently returning nothing
const miss = uiuxSearch("zzzzqqq", { domain: "style" });
assert.equal(miss.count, 0);
assert.ok(Array.isArray(miss.suggestions), "a miss should offer suggestions");

// the CSV parser has to survive quoted commas, escaped quotes and embedded newlines — the corpus
// is full of code snippets containing all three
const rows = parseCsv('A,B\n"x,1","he said ""hi"""\n"multi\nline",2\n');
assert.deepEqual(rows, [
  { A: "x,1", B: 'he said "hi"' },
  { A: "multi\nline", B: "2" },
]);

// --- parity with the Python it replaces ----------------------------------------------------
let python = null;
for (const bin of ["python", "python3", "py"]) {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    python = bin;
    break;
  } catch {
    /* try the next one */
  }
}

if (!python || !existsSync(`${UPSTREAM}/scripts/search.py`)) {
  console.log(
    "ok (node side only — python or the upstream checkout is unavailable, parity skipped)",
  );
} else {
  let compared = 0;
  for (const q of QUERIES) {
    const raw = execFileSync(
      python,
      [`${UPSTREAM}/scripts/search.py`, q, "--json"],
      {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    const py = JSON.parse(raw.slice(raw.indexOf("{")));
    const node = uiuxSearch(q);

    assert.equal(
      node.domain,
      py.domain,
      `domain differs for "${q}": node=${node.domain} python=${py.domain}`,
    );
    assert.equal(node.count, py.count, `result count differs for "${q}"`);

    // compare the identifying field of each row, in order — that is the ranking
    const idOf = (row) => Object.values(row)[0];
    assert.deepEqual(
      node.results.map(idOf),
      (py.results ?? []).map(idOf),
      `ranking differs for "${q}"`,
    );
    compared++;
  }
  console.log(
    `ok (${compared} queries match the python implementation exactly)`,
  );
}
