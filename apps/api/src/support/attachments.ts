/**
 * Support-form attachment policy: allowed types, encoding and size limits.
 * Pure (limits are passed in); the route maps a rejection to its HTTP reply.
 * Operations: docs/operations/support-attachments.md.
 */

/** One attachment as it arrives on the wire. */
export interface SupportAttachmentInput {
  filename: string;
  contentType: string;
  /** Base64, no `data:` prefix. */
  data: string;
}

export type SupportAttachmentErrorCode =
  | 'ATTACHMENT_COUNT_EXCEEDED'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_TYPE_NOT_ALLOWED'
  | 'ATTACHMENT_INVALID_ENCODING';

export interface AcceptedSupportAttachment extends SupportAttachmentInput {
  /** Decoded size, for the email's attachment listing. */
  bytes: number;
}

export type SupportAttachmentResult =
  | { ok: true; attachments: AcceptedSupportAttachment[] }
  | { ok: false; error: SupportAttachmentErrorCode; message: string };

/**
 * Content types the support form accepts. `contentType` is client-declared and
 * never checked against the bytes, so this is a UX filter only; the support
 * mailbox must scan attachments (docs/operations/support-attachments.md).
 *
 * A product decision, not an env knob; the UI reads it from `GET /support/config`.
 * Phone formats (HEIC, `.m4a`, 3GPP, AMR) are the most likely real submissions.
 * The `x-` variants exist because browsers derive the type from the extension:
 * Chrome reports `audio/x-m4a` for an iPhone voice memo.
 */
export const SUPPORT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/3gpp',
  'video/x-m4v',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/3gpp',
  'audio/amr',
];

/**
 * Extensions for the file picker's `accept` attribute. Needed because macOS
 * does not map `accept="audio/mp4"` to `.m4a`, greying out voice memos.
 * Picker hint only; validation stays MIME-based.
 */
export const SUPPORT_ALLOWED_EXTENSIONS: readonly string[] = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.3gp',
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.ogg',
  '.oga',
  '.amr',
];

const MAX_FILENAME_LENGTH = 120;

/**
 * Base64 alphabet plus padding, as one character class: a grouped RFC-4648
 * pattern backtracks and overflowed V8's regex stack on a 5 MB attachment.
 * Combined with the `length % 4` check it matches what notification-service's
 * `z.base64()` accepts.
 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strips whitespace and returns the compacted base64, or null when it is not
 * base64. `Buffer.from(x, 'base64')` silently ignores invalid characters, so
 * without this check a bad payload is mailed as a corrupt file.
 */
export function normaliseBase64(data: string): string | null {
  const compact = data.replace(/\s/g, '');
  if (!compact || compact.length % 4 !== 0 || !BASE64_RE.test(compact)) return null;
  return compact;
}

/** Decoded byte length of a base64 string without allocating a Buffer. Ignores whitespace. */
export function decodedBase64Length(data: string): number {
  const compact = data.replace(/\s/g, '');
  if (compact.length === 0) return 0;
  return Math.floor((compact.length * 3) / 4) - base64Padding(compact);
}

function base64Padding(compact: string): number {
  if (compact.endsWith('==')) return 2;
  if (compact.endsWith('=')) return 1;
  return 0;
}

/**
 * Makes a client-supplied filename safe for a MIME header: drops directories,
 * strips control characters and quotes (they can break out of `filename="..."`),
 * collapses whitespace, caps the length. An unusable name becomes `attachment`.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001F\u007F"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'attachment';
  return cleaned.slice(0, MAX_FILENAME_LENGTH);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validates attachments against the configured limits. Returns the accepted
 * attachments (sanitised names, decoded sizes) or the first rejection, checked
 * in order: count, then per-file type and encoding, then total size.
 */
export function validateSupportAttachments(
  attachments: SupportAttachmentInput[] | undefined,
  limits: { maxFiles: number; maxTotalBytes: number },
): SupportAttachmentResult {
  const list = attachments ?? [];
  if (list.length === 0) return { ok: true, attachments: [] };

  if (list.length > limits.maxFiles) {
    return {
      ok: false,
      error: 'ATTACHMENT_COUNT_EXCEEDED',
      message: `Attach at most ${limits.maxFiles} file${limits.maxFiles === 1 ? '' : 's'}.`,
    };
  }

  const accepted: AcceptedSupportAttachment[] = [];
  let totalBytes = 0;

  for (const item of list) {
    const contentType = item.contentType.trim().toLowerCase();
    if (!SUPPORT_ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return {
        ok: false,
        error: 'ATTACHMENT_TYPE_NOT_ALLOWED',
        message: `${sanitizeFilename(item.filename)} is not an accepted file type. Attach an image, video or audio file.`,
      };
    }
    // Forward the compacted form so notification-service's strict base64 check
    // accepts wrapped input.
    const data = normaliseBase64(item.data);
    if (!data) {
      return {
        ok: false,
        error: 'ATTACHMENT_INVALID_ENCODING',
        message: `${sanitizeFilename(item.filename)} could not be read. Please attach the file again.`,
      };
    }
    const bytes = decodedBase64Length(data);
    totalBytes += bytes;
    accepted.push({
      filename: sanitizeFilename(item.filename),
      contentType,
      data,
      bytes,
    });
  }

  if (totalBytes > limits.maxTotalBytes) {
    return {
      ok: false,
      error: 'ATTACHMENT_TOO_LARGE',
      message: `Attachments must total no more than ${formatBytes(limits.maxTotalBytes)}.`,
    };
  }

  return { ok: true, attachments: accepted };
}

/** Envelope headroom over the base64-inflated attachment budget. */
const ENVELOPE_HEADROOM_BYTES = 256 * 1024;

/**
 * Fastify body limit for the submit route: base64 inflation (4/3) plus envelope
 * headroom, derived so raising `SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES` never
 * causes a 413.
 */
export function supportBodyLimitBytes(maxTotalBytes: number): number {
  return Math.ceil((maxTotalBytes * 4) / 3) + ENVELOPE_HEADROOM_BYTES;
}
