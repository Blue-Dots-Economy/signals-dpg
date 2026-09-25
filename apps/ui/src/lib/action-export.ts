import { createApiClient } from './api-client';

/**
 * Client side of the engagement bulk export (#771): groups a My Actions
 * selection by counterparty type, calls `POST /api/v1/action/export`, and
 * saves the returned CSV. The server applies every rule (eligibility, reveal
 * gate, skips); this only shapes the request and reports the outcome.
 */

const apiClient = createApiClient();

/** The fields of an owned action this module reads. */
export interface ExportableAction {
  action_id: string;
  ownership_roles: ('initiated' | 'received')[];
  source_item_domain: string;
  target_item_domain: string;
}

/** Domain of the side the caller does NOT own. */
export function counterpartyDomainOf(
  action: Pick<ExportableAction, 'ownership_roles' | 'source_item_domain' | 'target_item_domain'>,
): string {
  return action.ownership_roles.includes('received')
    ? action.source_item_domain
    : action.target_item_domain;
}

export interface CounterpartyGroup {
  domain: string;
  actionIds: string[];
}

/**
 * One group per counterparty domain, sorted by domain. The server returns one
 * counterparty type per file, so each group is one download.
 */
export function groupByCounterpartyDomain(actions: readonly ExportableAction[]): CounterpartyGroup[] {
  const groups = new Map<string, string[]>();
  for (const a of actions) {
    const domain = counterpartyDomainOf(a);
    groups.set(domain, [...(groups.get(domain) ?? []), a.action_id]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, actionIds]) => ({ domain, actionIds }));
}

/** Filename from a `Content-Disposition` header, path separators neutralised. */
export function filenameFromContentDisposition(header: string | undefined): string {
  const match = header?.match(/filename="([^"]+)"/);
  return match ? match[1].replaceAll(/[/\\]/g, '_') : 'export.csv';
}

export interface ExportActionsBody {
  filters: {
    item_id?: string;
    ownership_role: 'all' | 'initiated' | 'received';
    action_ids?: string[];
    action_status?: string[];
    counterparty_domain?: string;
  };
  projection: { fields: '*' | string[] };
  format: 'csv';
}

export interface ExportActionsResult {
  blob: Blob;
  filename: string;
  exportId: string | undefined;
  rowCount: number;
  /** Rows that could not be included (cross-instance, deleted, not enabled, self). */
  skipped: number;
}

/** Typed failure of an export request; `status` 0 means no response. */
export class ActionExportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ActionExportError';
  }
}

const SKIP_HEADERS = [
  'x-export-skipped-cross-instance',
  'x-export-skipped-missing',
  'x-export-skipped-self',
  'x-export-skipped-not-enabled',
];

type ErrorLike = { isAxiosError?: boolean; response?: { status: number; data: unknown } };

async function toExportError(err: unknown): Promise<ActionExportError> {
  const response = (err as ErrorLike)?.response;
  if (!response) return new ActionExportError('Network error', 0, 'NETWORK_ERROR');
  // responseType 'blob' also applies to error bodies — read the JSON back out.
  let body: { error?: string; message?: string } = {};
  try {
    const data = response.data;
    const text = data instanceof Blob ? await data.text() : JSON.stringify(data ?? {});
    body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }
  return new ActionExportError(
    body.message ?? `HTTP error ${response.status}`,
    response.status,
    body.error ?? 'INTERNAL_SERVER_ERROR',
  );
}

/**
 * Requests one export file.
 *
 * @throws {ActionExportError} on any non-2xx response or transport failure.
 */
export async function exportActions(body: ExportActionsBody): Promise<ExportActionsResult> {
  try {
    const res = await apiClient.post<Blob>('/api/v1/action/export', body, { responseType: 'blob' });
    const headers = res.headers as Record<string, string | undefined>;
    const num = (h: string) => Number(headers[h] ?? 0) || 0;
    return {
      blob: res.data,
      filename: filenameFromContentDisposition(headers['content-disposition']),
      exportId: headers['x-export-id'],
      rowCount: num('x-export-row-count'),
      skipped: SKIP_HEADERS.reduce((sum, h) => sum + num(h), 0),
    };
  } catch (err) {
    throw await toExportError(err);
  }
}

/** Saves a blob through a temporary `<a download>`, then revokes its URL. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    URL.revokeObjectURL(url);
  }
}
