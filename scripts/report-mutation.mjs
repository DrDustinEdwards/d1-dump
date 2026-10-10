#!/usr/bin/env node
// Summarise a StrykerJS run. Measurement only: reads every reports/mutation/*.json
// (one per chunk), merges them, prints the mutation score and the per-test kill
// matrix summary. Deletes nothing and decides nothing.
//
// Candidates: zero-kill (kills no mutant) and covered (every kill is also made by
// another test; per test, not joint, so a pruning step must re-check).
// Protected (never candidates): table exclusion, retention, restore correctness.
// Matched by file and test name; a heuristic that errs toward keeping.
//
// Pass --json to write docs/research/kill-matrix.json.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const DIR = resolve(ROOT, "reports/mutation");
const reports = readdirSync(DIR)
  .filter((n) => n.endsWith(".json") && n !== "kill-matrix.json")
  .map((n) => JSON.parse(readFileSync(resolve(DIR, n), "utf8")));
if (reports.length === 0) {
  console.error("report-mutation: no reports/mutation/*.json. Run Stryker first.");
  process.exit(1);
}

const PROTECTED =
  /exclu|skip|retention|retain|prune|stale|restore|round.?trip|correct|reproduc|fts|fix|bug|regression/i;

const tests = new Map();
const counts = {};
const killers = new Map();
const perFile = {};
for (const report of reports) {
  const keyOf = new Map();
  for (const [file, entry] of Object.entries(report.testFiles ?? {})) {
    for (const t of entry.tests ?? []) {
      const key = `${file}::${t.name}`;
      keyOf.set(t.id, key);
      if (!tests.has(key)) tests.set(key, { file, name: t.name, kills: new Set() });
    }
  }
  for (const [file, entry] of Object.entries(report.files ?? {})) {
    const f = (perFile[file] ??= {});
    for (const m of entry.mutants ?? []) {
      counts[m.status] = (counts[m.status] ?? 0) + 1;
      f[m.status] = (f[m.status] ?? 0) + 1;
      const key = `${file}#${m.id}`;
      const by = m.killedBy ?? [];
      killers.set(key, by.length);
      for (const id of by) tests.get(keyOf.get(id))?.kills.add(key);
    }
  }
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(2)}%` : "n/a");
const score = (c) => {
  const k = (c.Killed ?? 0) + (c.Timeout ?? 0);
  const v = k + (c.Survived ?? 0) + (c.NoCoverage ?? 0);
  return { k, v, s: pct(k, v) };
};
const total = score(counts);
const killed = total.k;
const survived = counts.Survived ?? 0;

const rows = [];
for (const t of tests.values()) {
  let unique = 0;
  for (const key of t.kills) if (killers.get(key) === 1) unique += 1;
  const isProtected = PROTECTED.test(t.file) || PROTECTED.test(t.name);
  const kind = t.kills.size === 0 ? "zero-kill" : unique === 0 ? "covered" : "";
  rows.push({ file: t.file, name: t.name, kills: t.kills.size, unique, kind, protected: isProtected });
}
const zero = rows.filter((r) => r.kind === "zero-kill");
const covered = rows.filter((r) => r.kind === "covered");
console.log(`Reports merged: ${reports.length}`);
console.log("Mutant status counts:", counts);
console.log(`Mutation score: ${total.s} (${total.k} of ${total.v})`);
console.log(`Score over covered code: ${pct(killed, killed + survived)}`);
console.log(`Tests in matrix: ${rows.length}`);
console.log(`Zero-kill: ${zero.length} (${zero.filter((r) => r.protected).length} protected)`);
console.log(`Covered-by-others: ${covered.length} (${covered.filter((r) => r.protected).length} protected)`);
console.log(`Unprotected candidates: ${zero.filter((r) => !r.protected).length} zero-kill, ${covered.filter((r) => !r.protected).length} covered`);
console.log("\nPer file:");
for (const [file, c] of Object.entries(perFile).sort()) {
  const s = score(c);
  console.log(`| ${file} | ${s.v} | ${s.k} | ${c.Survived ?? 0} | ${c.NoCoverage ?? 0} | ${s.s} |`);
}
if (process.argv.includes("--json")) {
  mkdirSync(resolve(ROOT, "docs/research"), { recursive: true });
  writeFileSync(resolve(ROOT, "docs/research/kill-matrix.json"), JSON.stringify(rows, null, 2));
  console.log("Wrote docs/research/kill-matrix.json");
}
