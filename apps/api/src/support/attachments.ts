/**
 * Support-form attachment policy (#551): what may be attached to a
 * complaint/support submission, and how big it may be.
 *
 * Pure — no Fastify, no Redis, limits passed in — so every rejection path is
 * directly unit-testable. The route owns turning a rejection into its HTTP
 * reply.
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
  | 'ATTACHMENT_TYPE_NOT_ALLOWED';

export interface AcceptedSupportAttachment extends SupportAttachmentInput {
  /** Decoded size, for the email's attachment listing. */
  bytes: number;
}

export type SupportAttachmentResult =
  | { ok: true; attachments: AcceptedSupportAttachment[] }
  | { ok: false; error: SupportAttachmentErrorCode; message: string };

/**
 * Content types the support form accepts. Kept in code rather than in env on
 * purpose: an operator-editable type list is a short path to "the support inbox
 * now accepts executables", and adding a legitimate format is a one-line change
 * here that the UI picks up automatically (it reads this list from
 * `GET /support/config`).
 *
 * The phone-produced formats are deliberate, not incidental: iPhones hand out
 * HEIC photos, and Android cameras/voice recorders produce 3GPP and AMR.
 * Leaving them out would reject the most likely real submissions.
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
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/3gpp',
  'audio/amr',
];

const MAX_FILENAME_LENGTH = 120;

/**
 * Decoded byte length of a base64 string without decoding it, so an oversized
 * payload never costs a Buffer allocation. Whitespace is not counted.
 */
export function decodedBase64Length(data: string): number {
  const compact = data.replace(/\s/g, '');
  if (compact.length === 0) return 0;
  return Math.floor((compact.length * 3) / 4) - base64Padding(compact);
}

/** Number of `=` padding characters at the end of a base64 string (0, 1 or 2). */
function base64Padding(compact: string): number {
  if (compact.endsWith('==')) return 2;
  if (compact.endsWith('=')) return 1;
  return 0;
}

/**
 * Make a client-supplied filename safe to put in a MIME header and in front of
 * a support agent: drop any directory component, strip control characters and
 * quotes (both let a filename break out of the `filename="..."` parameter it
 * ends up in), collapse whitespace, cap the length. Never returns an empty
 * string — an unusable name degrades to `attachment`.
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

/** Human-readable size for the email's attachment listing. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Validate a submitted attachment list against the instance's configured
 * limits. Returns the accepted attachments (filenames sanitised, sizes
 * resolved) or the single rejection to reply with — count first, then type,
 * then total size, so the message names the first thing actually wrong rather
 * than a consequence of it.
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
    const bytes = decodedBase64Length(item.data);
    totalBytes += bytes;
    accepted.push({
      filename: sanitizeFilename(item.filename),
      contentType,
      data: item.data,
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
 * Fastify body limit for the submit route, derived from the attachment budget
 * rather than hardcoded: base64 inflates the payload by 4/3 and the JSON
 * envelope carries the rest of the form on top. Deriving it means raising
 * `SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES` can never turn into a silent 413.
 */
export function supportBodyLimitBytes(maxTotalBytes: number): number {
  return Math.ceil((maxTotalBytes * 4) / 3) + ENVELOPE_HEADROOM_BYTES;
}
