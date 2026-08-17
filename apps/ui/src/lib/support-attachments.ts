import type { SupportAttachment, SupportConfig } from '@/lib/support-api';

/**
 * Client-side half of the support-attachment rules (#551). The server validates
 * everything again — this exists so a user learns a file is too big before
 * spending time uploading it, not as the enforcement point.
 *
 * Pure and DOM-light (only `File`/`btoa`), so the rules are unit-testable
 * without rendering the dialog.
 */

/** Rejection reasons, mapped to i18n keys by the caller. */
export type AttachmentRejection =
  | { reason: 'count' }
  | { reason: 'size' }
  | { reason: 'type'; filename: string };

export type AttachmentSelectionResult =
  | { ok: true; files: File[] }
  | ({ ok: false } & AttachmentRejection);

/** Human-readable size, matching the API's formatting. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The `accept` attribute for the picker: MIME types *and* extensions.
 *
 * Types alone leave real files unselectable — macOS resolves `accept` through
 * its UTI table, which doesn't map `.m4a` (an iPhone voice memo) onto
 * `audio/mp4`, so the file shows up greyed out. Extensions are matched
 * literally, so listing both makes the picker agree with the API.
 */
export function pickerAccept(config: Pick<SupportConfig, 'allowedTypes' | 'allowedExtensions'>): string {
  return [...config.allowedTypes, ...(config.allowedExtensions ?? [])].join(',');
}

/**
 * Whether a file's type is accepted. Handles both exact types
 * (`image/png`, what the API serves) and `type/*` wildcards, which the offline
 * fallback config uses.
 */
export function matchesAllowedType(fileType: string, allowedTypes: string[]): boolean {
  const type = fileType.trim().toLowerCase();
  if (!type) return false;
  return allowedTypes.some((allowed) => {
    const candidate = allowed.trim().toLowerCase();
    if (candidate === type) return true;
    if (!candidate.endsWith('/*')) return false;
    return type.startsWith(candidate.slice(0, -1));
  });
}

/**
 * Validate what the picker would add to the current selection. Checked against
 * the combined list, not just the new files, since the limits are per
 * submission. Order matches the server: count, then type, then total size.
 */
export function validateAttachmentSelection(
  current: File[],
  incoming: File[],
  config: Pick<SupportConfig, 'maxFiles' | 'maxTotalBytes' | 'allowedTypes'>,
): AttachmentSelectionResult {
  const files = [...current, ...incoming];
  if (files.length > config.maxFiles) return { ok: false, reason: 'count' };

  for (const file of incoming) {
    if (!matchesAllowedType(file.type, config.allowedTypes)) {
      return { ok: false, reason: 'type', filename: file.name };
    }
  }

  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > config.maxTotalBytes) return { ok: false, reason: 'size' };

  return { ok: true, files };
}

/**
 * Base64-encode a file for the JSON body. Chunked rather than one
 * `String.fromCodePoint(...bytes)` call — spreading a multi-megabyte array into
 * arguments overflows the call stack. Every byte is 0–255, so code points and
 * char codes coincide here.
 */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCodePoint(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}

/** Encode the selection into the request payload shape. */
export async function encodeAttachments(files: File[]): Promise<SupportAttachment[]> {
  return Promise.all(
    files.map(async (file) => ({
      filename: file.name,
      // Browsers leave `type` empty for some files; the server's allowlist
      // rejects an empty type, so send a concrete value it can judge.
      contentType: file.type || 'application/octet-stream',
      data: await fileToBase64(file),
    })),
  );
}
