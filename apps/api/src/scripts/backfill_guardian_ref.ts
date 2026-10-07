/**
 * backfill_guardian_ref — re-canonicalise stored guardian phones to E.164 and
 * recompute `minor_guardian.guardian_ref`, so the per-guardian ward cap counts
 * wards linked before guardian phones were canonicalised. See
 * `services/guardian_ref_backfill.ts`.
 *
 * Run once per environment after deploying the E.164 guardian-phone change.
 * Until it runs, a guardian whose earlier links were typed in a non-E.164 form
 * is undercounted. Idempotent: a second run rewrites nothing. Needs the API env
 * (database + SIGNALS_PII_KEY) because the contact is decrypted.
 *
 * Ships compiled in the api image; run:
 *   node dist/scripts/backfill_guardian_ref.js [--dry-run]
 *   (local: pnpm --filter api db:backfill:guardian-ref:dev -- --dry-run)
 */
import { backfillGuardianRefs } from '@/services/guardian_ref_backfill';

function parseArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg !== '--') throw new Error(`unknown arg: ${arg}`);
  }
  return { dryRun };
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const s = await backfillGuardianRefs({ dryRun });
  console.log(
    `backfill_guardian_ref: scanned=${s.scanned} updated=${s.updated} unchanged=${s.unchanged}` +
      ` failed=${s.failed} raced=${s.raced}${dryRun ? ' (dry-run — no writes)' : ''}`,
  );
  if (s.failed > 0) {
    console.error('backfill_guardian_ref: some rows could not be decrypted (wrong SIGNALS_PII_KEY?)');
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('backfill_guardian_ref failed:', err);
  process.exit(1);
}
process.exit(process.exitCode ?? 0);
