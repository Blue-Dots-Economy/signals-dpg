import { bulkFailureIndices, firstBulkError, type BulkEnvelope } from './bulk';
import { guardianOtpErrorOf, type PerformActionPayload } from './action-api';

/**
 * The meaning of a completed bulk action, as one value. Kept out of `bulk.ts`
 * because it needs `action-api`, which already imports `bulk`.
 */
export type BulkOutcome =
  | { kind: 'all'; succeeded: number }
  | { kind: 'guardian'; payloads: PerformActionPayload[]; otherFailedIds?: string[] }
  | {
      kind: 'partial';
      failedIds: string[];
      firstError?: string;
      succeeded: number;
      total: number;
    };

/**
 * `targets` and `payloads` must be index-aligned with the batch that produced
 * `env`; results are identified only by `index`.
 *
 * `guardian` wins over `partial`: any `GUARDIAN_OTP_REQUIRED` means a code was
 * already sent to the guardian, so a mixed batch must still open the OTP
 * dialog. The other failures go in `otherFailedIds` and are reselected after it.
 */
export function resolveBulkOutcome<T>(
  env: BulkEnvelope<T>,
  targets: readonly { item_id: string }[],
  payloads: readonly PerformActionPayload[],
): BulkOutcome {
  if (env.summary.failed === 0) return { kind: 'all', succeeded: env.summary.succeeded };

  const failedResults = env.results.filter((r) => r.status === 'error');
  const guardianResults = failedResults.filter(
    (r) => guardianOtpErrorOf(r) === 'GUARDIAN_OTP_REQUIRED',
  );

  if (guardianResults.length > 0) {
    const otherFailedIds = failedResults
      .filter((r) => guardianOtpErrorOf(r) !== 'GUARDIAN_OTP_REQUIRED')
      .map((r) => targets[r.index].item_id);
    return {
      kind: 'guardian',
      payloads: guardianResults.map((r) => payloads[r.index]),
      otherFailedIds: otherFailedIds.length > 0 ? otherFailedIds : undefined,
    };
  }

  return {
    kind: 'partial',
    failedIds: bulkFailureIndices(env).map((i) => targets[i].item_id),
    firstError: firstBulkError(env) ?? undefined,
    succeeded: env.summary.succeeded,
    total: env.summary.total,
  };
}
