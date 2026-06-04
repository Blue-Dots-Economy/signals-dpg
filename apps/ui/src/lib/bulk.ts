import { isAxiosError } from 'axios';

/**
 * T must not declare its own `status` field — the bulk envelope reserves
 * `status` for the per-item discriminant ('success' | 'error'), and
 * envelopeToResult strips it before returning the caller's response shape.
 * If a future response type ever added a bare `status` field that field would
 * be silently lost; this constraint turns that into a compile-time error.
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
 * Error thrown when a single-item bulk call's one element failed. Carries the
 * per-item machine code. A synthetic `response` mirrors the old AxiosError shape
 * (`response.data.error` / `.message`) so existing call-site error handling that
 * reads those fields keeps working.
 */
export class BulkSingleError extends Error {
  code: string;
  // `response.status` is the HTTP response status (e.g. 422 for an all-fail
  // single-item bulk call), which is why callers' `status === 401` checks
  // correctly never match a per-item bulk failure.
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
  // strip envelope-only fields (`index`, `status`), return the caller's response shape
  const { index: _index, status: _status, ...data } = first;
  return data as T;
}

/**
 * Await a bulk POST that wraps a single payload, and unwrap results[0].
 * On success (200/201) axios resolves → unwrap. On all-fail (422) axios rejects
 * with the envelope in response.data → unwrap that to throw a BulkSingleError.
 * Genuine request-level errors (401, network failure, 400 {error,message} with
 * no `results`) are rethrown unchanged.
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
 * Await a bulk POST that wraps an array of payloads, returning the full
 * envelope. On 200/201/207 axios resolves → return data. On 422 (all items
 * failed) axios rejects with the envelope in response.data → return that.
 * Genuine request-level errors (401, network failure, 400 {error,message}
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
