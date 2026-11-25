---
"@dustinedwards/d1-dump": minor
---

Hardening from the 2026-11-25 audit. `runCheckedBackup` checks for credential columns before it writes anything and does it by default (`credentials: false` turns it off), and the name pattern covers passphrases, one-time and recovery codes, and access, encryption and signing keys, FTS5 columns included. `restoreDump` refuses a marker without checksums (`allowUnchecked` for a run from before 0.16.0), a schema entry that is not the CREATE its type names, and a target that is not empty. Gunzip stops at 64 MiB. `drill --dir` uses sqlite unless `--backend d1` is passed, the REST bucket client refuses dot segments, the scratch D1 client encodes the account id, and the search check no longer logs a word from a row.
