#!/usr/bin/env node
import { cloudflareScratch } from "./cloudflare.js";
import { runRestoreDrill } from "./drill.js";
import { directoryBucket } from "./node.js";

const USAGE = `usage: d1-dump drill --dir <downloaded dump root> [--prefix <backups/json/run id/>] [--max-age-hours <n|off>]
needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (create and delete D1 databases) in the environment`;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function main(args: string[]): Promise<number> {
  const dir = arg(args, "--dir");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (args[0] !== "drill" || !dir || !accountId || !token) {
    console.error(USAGE);
    return 2;
  }
  const age = arg(args, "--max-age-hours");
  const result = await runRestoreDrill(directoryBucket(dir), {
    createScratch: cloudflareScratch(accountId, token),
    prefix: arg(args, "--prefix"),
    maxAgeHours: age === undefined ? undefined : age === "off" ? null : Number(age),
  });
  console.log(`restore drill ${result.ok ? "PASSED" : "FAILED"}: ${result.run ?? "no dump"} into ${result.scratch}`);
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
