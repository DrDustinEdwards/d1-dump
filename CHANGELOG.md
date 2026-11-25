# @dustinedwards/d1-dump

## 0.18.0

### Minor Changes

- Hardening from the 2026-11-25 audit. `runCheckedBackup` checks for credential columns before it writes anything and does it by default (`credentials: false` turns it off), and the name pattern covers passphrases, one-time and recovery codes, and access, encryption and signing keys, FTS5 columns included. `restoreDump` refuses a marker without checksums (`allowUnchecked` for a run from before 0.16.0), a schema entry that is not the CREATE its type names, and a target that is not empty. Gunzip stops at 64 MiB. `drill --dir` uses sqlite unless `--backend d1` is passed, the REST bucket client refuses dot segments, the scratch D1 client encodes the account id, and the search check no longer logs a word from a row.

## 0.17.1

### Patch Changes

- Restore tables with generated columns: the dump holds them, the restore leaves them to SQLite.

## 0.17.0

### Minor Changes

- Export `listAllKeys`, so a site lists every key under a prefix without copying it.

## 0.16.3

### Patch Changes

- A small object R2 refuses with error 10058, "Reduce your concurrent request rate for the same object", is written again after a pause (four tries, doubling from half a second). Overlapping runs write the same latest pointer and progress objects, and one refusal failed the whole backup (Carrel's CARREL-8).

## 0.16.2

### Patch Changes

- The files drill passes a files backup whose last complete pass found no files in its source, instead of failing it with "no copies".
