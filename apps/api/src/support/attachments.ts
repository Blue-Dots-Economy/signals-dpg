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
 * Content types the support form accepts.
 *
 * Scope, so nobody mistakes this for more than it is: `contentType` is declared
 * by the client and never checked against the bytes, so this rejects an honest
 * mistake (a PDF, a zip) but not a renamed executable sent with
 * `contentType: image/png`. It is a UX filter, and the support mailbox must
 * still scan what it receives — see docs/operations/support-attachments.md.
 *
 * Kept in code rather than in env because the list is a product decision about
 * what the form is for, not a per-deployment knob; adding a legitimate format is
 * a one-line change here that the UI picks up automatically (it reads this list
 * from `GET /support/config`).
 *
 * The phone-produced formats are deliberate, not incidental: iPhones hand out
 * HEIC photos and `.m4a` voice memos, and Android cameras/voice recorders
 * produce 3GPP and AMR. Leaving them out would reject the most likely real
 * submissions.
 *
 * Note the `x-` variants. A browser picks the type from its own extension table,
 * not from the file: Chrome reports `audio/x-m4a` for a `.m4a` (an iPhone voice
 * memo, the commonest voice attachment there is) even though the container is
 * MPEG-4 audio. Listing only the canonical `audio/mp4` rejected those.
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
 * Extensions for the file picker's `accept` attribute, alongside the MIME list.
 *
 * MIME types alone are not enough: macOS maps `accept="audio/mp4"` through its
 * own UTI table, which does not claim `.m4a`, so a voice memo shows up greyed
 * out in the picker even though the API would accept it. Extensions are matched
 * literally by the browser and close that gap. They are a picker hint only —
 * validation stays MIME-based on both sides.
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
 * Base64 alphabet plus optional padding. Deliberately a single character class
 * with no grouped quantifier: the obvious RFC-4648 pattern
 * (`^(?:[A-Za-z0-9+/]{4})*(?:..[AEIMQUYcgkosw048]=|...)?$`) has to backtrack over
 * every 4-char group when the tail fails to match, and on a max-legal 5 MB
 * attachment that overflowed V8's regex stack — a valid submission became a 500.
 * This form is linear in the input, so a 7 MB string costs the same whether it
 * passes or fails.
 *
 * `length % 4` carries the rest of the rule (the grouped pattern got that from
 * its `{4}` repetition). Together they accept exactly what the notification
 * service's `z.base64()` accepts — verified by differential comparison — so this
 * side can never wave through a payload the relay will reject.
 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strips whitespace and checks the result really is base64.
 *
 * Worth doing rather than trusting the decoder: `Buffer.from(x, 'base64')`
 * silently ignores anything outside the alphabet, so a `data:` URL prefix, a
 * truncated upload or binary noise decodes to garbage and is mailed as a corrupt
 * file with no error raised anywhere. Wrapped base64 (newlines every 76 chars)
 * is legitimate, so it is compacted rather than rejected.
 *
 * @param data - Raw `data` value as submitted.
 * @returns The compacted base64, or null when it is not base64 at all.
 */
export function normaliseBase64(data: string): string | null {
  const compact = data.replace(/\s/g, '');
  if (!compact || compact.length % 4 !== 0 || !BASE64_RE.test(compact)) return null;
  return compact;
}

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
    // Checked, not assumed: the decoder ignores anything outside the base64
    // alphabet, so an unvalidated payload is mailed as a corrupt file with no
    // error raised. The compacted form is what gets forwarded, so the
    // notification service's strict base64 check never trips on wrapped input.
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
 * Fastify body limit for the submit route, derived from the attachment budget
 * rather than hardcoded: base64 inflates the payload by 4/3 and the JSON
 * envelope carries the rest of the form on top. Deriving it means raising
 * `SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES` can never turn into a silent 413.
 */
export function supportBodyLimitBytes(maxTotalBytes: number): number {
  return Math.ceil((maxTotalBytes * 4) / 3) + ENVELOPE_HEADROOM_BYTES;
}
