/**
 * Per-item error thrown by a processOne callback. The runner converts it into
 * an error entry in the results array (does NOT abort the batch).
 */
export class BulkItemFailure extends Error {
  constructor(
    public readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'BulkItemFailure';
  }
}

type SuccessResult<T> = { index: number; status: 'success' } & T;
interface ErrorResult {
  index: number;
  status: 'error';
  error: string;
  message: string;
}
export type BulkItemResult<T> = SuccessResult<T> | ErrorResult;

export interface BulkOutcome<T> {
  /** Set only for request-level rejection (empty / over-limit). Caller → 400. */
  requestError?: { code: string; message: string };
  results?: BulkItemResult<T>[];
  summary?: { total: number; succeeded: number; failed: number };
  /** okStatus when all succeed, 207 on partial, 422 when all fail. */
  httpStatus?: number;
}

/**
 * Run `processOne` over each element best-effort. Sequential by design (v1):
 * keeps DB partition creation and cross-instance fan-out predictable.
 */
export async function runBulk<T extends object>(
  elements: unknown[],
  processOne: (element: unknown, index: number) => Promise<T>,
  opts: { okStatus: number; maxItems: number; onUnexpectedError?: (err: unknown, index: number) => void },
): Promise<BulkOutcome<T>> {
  if (elements.length === 0) {
    return {
      requestError: {
        code: 'BULK_EMPTY_ARRAY',
        message: 'Request body must be a non-empty array.',
      },
    };
  }
  if (elements.length > opts.maxItems) {
    return {
      requestError: {
        code: 'BULK_LIMIT_EXCEEDED',
        message: `Request exceeds the maximum of ${opts.maxItems} items per call (received ${elements.length}).`,
      },
    };
  }

  const results: BulkItemResult<T>[] = [];
  let succeeded = 0;

  for (let index = 0; index < elements.length; index++) {
    try {
      const success = await processOne(elements[index], index);
      results.push({ index, status: 'success', ...success });
      succeeded += 1;
    } catch (err) {
      if (err instanceof BulkItemFailure) {
        results.push({ index, status: 'error', error: err.errorCode, message: err.message });
      } else {
        opts.onUnexpectedError?.(err, index);
        results.push({
          index,
          status: 'error',
          error: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred.',
        });
      }
    }
  }

  const failed = results.length - succeeded;
  const httpStatus = failed === 0 ? opts.okStatus : succeeded === 0 ? 422 : 207;

  return { results, summary: { total: results.length, succeeded, failed }, httpStatus };
}
