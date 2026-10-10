# d1-dump baseline (job_8e49d3d19f23)

Measured 2026-10-10 at commit 44c3f4d (main). Linux container, 4 cores, Node 22.22
(package.json asks for >=24.14.1; the suite ran fine on 22). Same method as the
Foxhound baseline. Nothing was deleted, no source changed, no package.json or
lockfile edit (Stryker was installed with `--no-save`).

## Test suite

| What | Command | Result |
|------|---------|--------|
| Tests | `npx vitest run` | 5 files, 46 tests passed, about 25 s (each test starts workerd through Miniflare) |
| Source | `wc -l src/*.ts` | 11 files, 1,243 lines; test/ is 828 lines (5 test files plus helpers.ts) |

## Mutation testing (StrykerJS 9.6.1)

Setup: vitest runner, `coverageAnalysis: perTest`, `disableBail`, `ignoreStatic`,
concurrency 4, timeout 60 s. Mutated: all of `src/` (11 files). `stryker.config.mjs`
runs it in five chunks, each pushed to the branch
`results/d1-dump-mutation-baseline` (`chunks/`) as soon as it finished. Chunk
wall time: drill 20 min, dump (with schema) 34 min, restore (with r2) 18 min,
rest 3 min (the runs chunk was run in the foreground and its time was not recorded).

Reproduce:

    npm i --no-save @stryker-mutator/core@9.6.1 @stryker-mutator/vitest-runner@9.6.1
    for c in drill dump restore runs rest; do STRYKER_CHUNK=$c npx stryker run; done
    node scripts/report-mutation.mjs --json

### Score

| Status | Mutants |
|--------|---------|
| Killed | 837 |
| Timeout (counted as killed) | 14 |
| Survived | 212 |
| No coverage | 91 |
| Ignored (static) | 18 |
| Valid (killed + survived + no coverage) | 1,154 |

- **Mutation score: 73.74%** (851 of 1,154).
- Score over covered code: 80.06% (851 of 1,063).
- 7.9% of mutants have no covering test.

### Per file

| File | Valid | Killed | Survived | No coverage | Score |
|------|-------|--------|----------|-------------|-------|
| src/cli.ts | 55 | 0 | 0 | 55 | 0.00% |
| src/cloudflare.ts | 66 | 56 | 6 | 4 | 84.85% |
| src/drill.ts | 258 | 198 | 50 | 10 | 76.74% |
| src/dump.ts | 125 | 100 | 21 | 4 | 80.00% |
| src/node.ts | 112 | 98 | 11 | 3 | 87.50% |
| src/r2.ts | 51 | 38 | 7 | 6 | 74.51% |
| src/restore.ts | 147 | 107 | 37 | 3 | 72.79% |
| src/runs.ts | 182 | 144 | 35 | 3 | 79.12% |
| src/schema.ts | 158 | 110 | 45 | 3 | 69.62% |

`src/cli.ts` is the whole no-coverage story: no test imports it. `index.ts` and
`types.ts` have no mutants. `schema.ts`, `restore.ts` and `runs.ts` hold most of
the survivors, which is where added tests would pay most.

### Per-test kill matrix

46 tests, keyed by file and test name. The full matrix (per test: kills, unique
kills, candidate kind, protected flag) is `docs/research/kill-matrix.json`.

| Group | Tests | Of which protected |
|-------|-------|--------------------|
| Zero-kill (kills no mutant) | 3 | 2 |
| Covered by others (every kill is also made by another test) | 11 | 10 |
| Unprotected candidates | 2 (1 zero-kill, 1 covered) | |

Protected means the file or test name matches the keep rules in
`scripts/report-mutation.mjs`: table exclusion, retention and pruning, restore
correctness, FTS5, round trips, reproductions, and tests written for a fixed bug.
It is a name heuristic that errs toward keeping.

### Removal candidates (nothing removed)

Every test that is zero-kill or covered by others:

| Test file | Test | Kills | Unique | Kind | Protected |
|---|---|---|---|---|---|
| test/runs.test.ts | prune deletes nothing while no complete run exists, which is what a wrong bucket looks like | 19 | 0 | covered | yes (retention) |
| test/runs.test.ts | graduated prune keeps exactly the expected set over a 200 day history with a missing day and a second run in one day | 85 | 0 | covered | yes (retention) |
| test/runs.test.ts | graduated prune crosses a year boundary: December's copy and the week of New Year both survive | 82 | 0 | covered | yes (retention) |
| test/drill.test.ts | a dropped FTS5 rebuild fails the fts and search checks, though every table restored | 276 | 0 | covered | yes (restore correctness) |
| test/drill.test.ts | a row lost after the restore's own count check fails the drill's recount | 264 | 0 | covered | yes (restore correctness) |
| test/drill.test.ts | only node.ts imports node:, so the package entry bundles into a Worker | 0 | 0 | zero-kill | **no** |
| test/roundtrip.test.ts | a failed write leaves no marker, so the run is not a complete dump | 54 | 0 | covered | yes (restore correctness) |
| test/reproduce.test.ts | wrangler d1 export on FTS5 refuses a database with an FTS5 table, and writes no file | 0 | 0 | zero-kill | yes |
| test/reproduce.test.ts | wrangler d1 export on FTS5 exports the same database once the FTS5 table is gone, so the FTS5 table is the cause | 0 | 0 | zero-kill | yes |
| test/reproduce.test.ts | dumpDatabase dumps that same FTS5 database | 98 | 0 | covered | yes |
| test/sqlite.test.ts | sqlite: a good dump passes every check, and a BLOB comes back as a BLOB | 378 | 0 | covered | **no** |
| test/sqlite.test.ts | sqlite: a 141 KB value with newlines restores byte for byte and no statement is over the cap | 341 | 0 | covered | yes (restore correctness) |
| test/sqlite.test.ts | sqlite: a dropped FTS5 rebuild fails the fts and search checks | 295 | 0 | covered | yes (restore correctness) |
| test/sqlite.test.ts | sqlite: a row lost after the restore's own count check fails the recount, and the scratch file is still removed | 296 | 0 | covered | yes (restore correctness) |

Reading it:

- Only two tests are unprotected, and neither should go on this evidence alone.
  The `node:` import test is a bundling guard that no mutant can trip (it checks
  imports, not behavior). The sqlite BLOB test has every kill shared with another
  test; whether it is the only one asserting BLOB typing was not checked.
- The two wrangler reproduction tests kill nothing because they run `wrangler d1
  export` against Miniflare, not `src/`. They are the evidence for why this
  package exists, so they stay.
- Candidates are per test, not joint. Several "covered" tests are pairs (drill and
  sqlite versions of the same check) that only cover each other; removing both
  would lose kills.
- Survivors (212) point the other way: they show behavior no test pins. Adding
  tests for `schema.ts`, `restore.ts`, `runs.ts` and `cli.ts` is worth more than
  trimming a 46 test suite.

Nothing was deleted or changed in the source or the tests.
