#!/usr/bin/env node
import { cloudflareScratch } from "./cloudflare.js";
import { runRestoreDrill } from "./drill.js";
import { directoryBucket, drillFromBucket, pickBackend, sqliteScratch } from "./node.js";

const USAGE = `usage: d1-dump drill --dir <downloaded dump root> [--backend sqlite|d1] [--prefix <backups/json/run id/>] [--max-age-hours <n|off>]
       d1-dump drill --bucket <bucket name> [--prefix <backups/json/>] [--backend sqlite|d1] [--max-age-hours <n|off>]
  --bucket downloads the newest complete run through the R2 REST API with CLOUDFLARE_ACCOUNT_ID and
          CLOUDFLARE_API_TOKEN (R2 read), then drills it; exits 0 passed, 1 a check failed, 3 could not run
  sqlite  restores into a local SQLite file and needs no credential (the default when no Cloudflare credentials are set)
  d1      restores into a scratch D1 database over the REST API; needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
          (create and delete D1 databases) in the environment`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function maxAge(args: string[]): number | null | undefined {
  const age = arg(args, "--max-age-hours");
  return age === undefined ? undefined : age === "off" ? null : Number(age);
}

async function main(args: string[]): Promise<number> {
  const dir = arg(args, "--dir");
  const bucket = arg(args, "--bucket");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (args[0] === "drill" && bucket && !dir) {
    const { code, lines } = await drillFromBucket({ accountId, apiToken: token, bucket, prefix: arg(args, "--prefix"), backend: arg(args, "--backend"), maxAgeHours: maxAge(args) });
    for (const line of lines) console.log(line);
    return code;
  }
  const asked = arg(args, "--backend");
  const picked = pickBackend(asked, Boolean(accountId && token));
  if (args[0] !== "drill" || !dir || "error" in picked) {
    console.error(`${"error" in picked ? `d1-dump: ${picked.error}\n` : ""}${USAGE}`);
    return 2;
  }
  const { backend, why } = picked;
  console.log(`backend: ${backend} (${why})`);
  const result = await runRestoreDrill(directoryBucket(dir), {
    createScratch: backend === "d1" ? cloudflareScratch(accountId!, token!) : sqliteScratch(),
    prefix: arg(args, "--prefix"),
    maxAgeHours: maxAge(args),
  });
  console.log(`restore drill ${result.ok ? "PASSED" : "FAILED"}: ${result.run ?? "no dump"} into ${result.scratch} (${backend})`);
  for (const c of result.checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  return result.ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`d1-dump: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
);
