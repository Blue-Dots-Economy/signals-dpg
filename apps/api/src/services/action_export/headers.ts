/**
 * Response headers of `POST /api/v1/action/export` (#770) the browser must be
 * allowed to read. The UI calls the API cross-origin, so without CORS
 * `exposedHeaders` it cannot see the filename or the row / skip counts.
 */
export const EXPORT_EXPOSED_HEADERS = [
  'Content-Disposition',
  'X-Export-Id',
  'X-Export-Generated-At',
  'X-Export-Row-Count',
  'X-Export-Skipped-Cross-Instance',
  'X-Export-Skipped-Missing',
  'X-Export-Skipped-Self',
  'X-Export-Skipped-Not-Enabled',
] as const;
