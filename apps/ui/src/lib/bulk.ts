import { isAxiosError } from 'axios';

/**
 * The bulk envelope reserves `status` for the per-item discriminant and
 * `envelopeToResult` strips it, so a response type with its own `status` field
 * would lose it silently; this makes that a compile-time error.
 */
type NoStatusField<T> = T extends { status: unknown } ? never : T;

interface BulkItemError {
  index: number;
  status: 'error';
  error: string;
  message: string;
}
type BulkResult<T> = ({ index: number; status: 'success' } & T) | BulkItemError;

export interface BulkEnvelope<T> {
  results: BulkResult<T>[];
  summary: { total: number; succeeded: number; failed: number };
}

/**
 * Thrown when a single-item bulk call's one element failed. `code` is the
 * per-item machine code; `response` mirrors the AxiosError shape
 * (`response.data.error` / `.message`) for call-site error handling.
 */
export class BulkSingleError extends Error {
  code: string;
  // The HTTP status (e.g. 422 for an all-fail call), so callers' `status === 401`
  // checks never match a per-item failure.
  response: { status?: number; data: { error: string; message: string } };
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'BulkSingleError';
    this.code = code;
    this.response = { status, data: { error: code, message } };
  }
}

function envelopeToResult<T extends object>(env: BulkEnvelope<NoStatusField<T>>, status?: number): T {
  const first = env.results?.[0];
  if (!first || first.status === 'error') {
    throw new BulkSingleError(
      first?.error ?? 'UNKNOWN',
      first?.message ?? 'Request failed',
      status,
    );
  }
  // Strip envelope-only fields (`index`, `status`).
  const { index: _index, status: _status, ...data } = first;
  return data as T;
}

/**
 * Awaits a bulk POST wrapping one payload and unwraps results[0]. A 422
 * all-fail rejects with the envelope, which becomes a `BulkSingleError`.
 * Request-level errors (401, network failure, 400 without `results`) are
 * rethrown unchanged.
 */
export async function unwrapBulkSingle<T extends object>(
  request: Promise<{ status: number; data: BulkEnvelope<NoStatusField<T>> }>,
): Promise<T> {
  try {
    const response = await request;
    return envelopeToResult(response.data, response.status);
  } catch (err) {
    if (
      isAxiosError(err) &&
      err.response?.data &&
      Array.isArray((err.response.data as Partial<BulkEnvelope<NoStatusField<T>>>).results)
    ) {
      return envelopeToResult(err.response.data as BulkEnvelope<NoStatusField<T>>, err.response.status);
    }
    throw err;
  }
}

/**
 * Awaits a bulk POST of several payloads and returns the full envelope,
 * including on a 422 all-fail. Request-level errors (401, network failure, 400
 * without `results`) are rethrown unchanged.
 */
export async function postBulkEnvelope<T extends object>(
  request: Promise<{ data: BulkEnvelope<NoStatusField<T>> }>,
): Promise<BulkEnvelope<T>> {
  try {
    const res = await request;
    return res.data as BulkEnvelope<T>;
  } catch (err) {
    if (
      isAxiosError(err) &&
      err.response?.data &&
      Array.isArray((err.response.data as Partial<BulkEnvelope<NoStatusField<T>>>).results)
    ) {
      return err.response.data as BulkEnvelope<T>;
    }
    throw err;
  }
}

/** The request indices (echoed by the server as `index`) of items that failed. */
export function bulkFailureIndices<T>(env: BulkEnvelope<T>): number[] {
  return env.results.filter((r) => r.status === 'error').map((r) => r.index);
}

/** The first per-item error message in the envelope, if any. */
export function firstBulkError<T>(env: BulkEnvelope<T>): string | null {
  const f = env.results.find((r) => r.status === 'error');
  return f && f.status === 'error' ? f.message : null;
}
