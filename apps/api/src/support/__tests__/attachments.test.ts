import { describe, expect, it } from 'vitest';
import {
  SUPPORT_ALLOWED_CONTENT_TYPES,
  decodedBase64Length,
  formatBytes,
  sanitizeFilename,
  supportBodyLimitBytes,
  validateSupportAttachments,
} from '../attachments';

const LIMITS = { maxFiles: 3, maxTotalBytes: 5 * 1024 * 1024 };

const png = (bytes: number, over: Record<string, string> = {}) => ({
  filename: 'evidence.png',
  contentType: 'image/png',
  data: Buffer.alloc(bytes, 3).toString('base64'),
  ...over,
});

describe('decodedBase64Length', () => {
  it('matches the real decoded size for every padding case', () => {
    for (const raw of ['', 'a', 'ab', 'abc', 'abcd', 'a longer payload here']) {
      expect(decodedBase64Length(Buffer.from(raw).toString('base64'))).toBe(raw.length);
    }
  });

  it('ignores whitespace in wrapped base64', () => {
    const raw = Buffer.alloc(300, 1);
    const wrapped = raw.toString('base64').replace(/(.{24})/g, '$1\n');
    expect(decodedBase64Length(wrapped)).toBe(300);
  });
});

describe('sanitizeFilename', () => {
  it('drops directory components', () => {
    expect(sanitizeFilename('../../etc/passwd.png')).toBe('passwd.png');
    expect(sanitizeFilename('C:\\Users\\me\\shot.png')).toBe('shot.png');
  });

  it('strips quotes and control characters that could break a MIME header', () => {
    expect(sanitizeFilename('ev"idence\r\n.png')).toBe('evidence.png');
    expect(sanitizeFilename("it's a photo.png")).toBe('its a photo.png');
  });

  it('degrades an unusable name to a placeholder instead of an empty string', () => {
    expect(sanitizeFilename('')).toBe('attachment');
    expect(sanitizeFilename('/')).toBe('attachment');
    expect(sanitizeFilename('..')).toBe('attachment');
    expect(sanitizeFilename('"""')).toBe('attachment');
  });

  it('caps the length', () => {
    expect(sanitizeFilename(`${'a'.repeat(500)}.png`)).toHaveLength(120);
  });

  it('keeps ordinary unicode names intact', () => {
    expect(sanitizeFilename('शिकायत.png')).toBe('शिकायत.png');
  });
});

describe('validateSupportAttachments', () => {
  it('accepts an absent or empty list', () => {
    expect(validateSupportAttachments(undefined, LIMITS)).toEqual({ ok: true, attachments: [] });
    expect(validateSupportAttachments([], LIMITS)).toEqual({ ok: true, attachments: [] });
  });

  it('resolves sizes and sanitised filenames for accepted files', () => {
    const result = validateSupportAttachments([png(1024, { filename: 'dir/a.png' })], LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments[0].filename).toBe('a.png');
    expect(result.attachments[0].bytes).toBe(1024);
  });

  it('rejects more files than allowed', () => {
    const result = validateSupportAttachments([png(8), png(8), png(8), png(8)], LIMITS);
    expect(result).toMatchObject({ ok: false, error: 'ATTACHMENT_COUNT_EXCEEDED' });
  });

  it('rejects on total size, not per-file size', () => {
    const limits = { maxFiles: 3, maxTotalBytes: 4096 };
    expect(validateSupportAttachments([png(4000)], limits).ok).toBe(true);
    expect(validateSupportAttachments([png(3000), png(3000)], limits)).toMatchObject({
      ok: false,
      error: 'ATTACHMENT_TOO_LARGE',
    });
  });

  it('accepts a total exactly on the limit', () => {
    expect(validateSupportAttachments([png(4096)], { maxFiles: 3, maxTotalBytes: 4096 }).ok).toBe(
      true,
    );
  });

  it('rejects a content type outside the allowlist and names the file', () => {
    const result = validateSupportAttachments(
      [{ filename: 'run.exe', contentType: 'application/x-msdownload', data: 'eA==' }],
      LIMITS,
    );
    expect(result).toMatchObject({ ok: false, error: 'ATTACHMENT_TYPE_NOT_ALLOWED' });
    if (result.ok) return;
    expect(result.message).toContain('run.exe');
  });

  it('accepts every allowlisted type, including phone-produced formats', () => {
    for (const contentType of SUPPORT_ALLOWED_CONTENT_TYPES) {
      expect(validateSupportAttachments([png(16, { contentType })], LIMITS).ok).toBe(true);
    }
    for (const phoneType of ['image/heic', 'video/3gpp', 'audio/amr']) {
      expect(SUPPORT_ALLOWED_CONTENT_TYPES).toContain(phoneType);
    }
    // Chrome types a .m4a — an iPhone voice memo — as audio/x-m4a, not the
    // canonical audio/mp4, so the picker greyed them out and the API refused
    // them until this was listed.
    expect(SUPPORT_ALLOWED_CONTENT_TYPES).toContain('audio/x-m4a');
  });

  it('normalises content-type case and surrounding whitespace', () => {
    expect(validateSupportAttachments([png(16, { contentType: ' IMAGE/PNG ' })], LIMITS).ok).toBe(
      true,
    );
  });

  it('reports the count problem before the size problem', () => {
    // Four oversized files break both rules; the message should name the one the
    // user can act on first rather than a consequence of it.
    const result = validateSupportAttachments([png(5000), png(5000), png(5000), png(5000)], {
      maxFiles: 3,
      maxTotalBytes: 4096,
    });
    expect(result).toMatchObject({ ok: false, error: 'ATTACHMENT_COUNT_EXCEEDED' });
  });
});

describe('formatBytes', () => {
  it('scales the unit to the size', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('supportBodyLimitBytes', () => {
  it('leaves room for base64 inflation plus the rest of the form', () => {
    const cap = 5 * 1024 * 1024;
    expect(supportBodyLimitBytes(cap)).toBeGreaterThan(Math.ceil((cap * 4) / 3));
  });

  it('tracks the cap, so raising the cap cannot produce a 413', () => {
    expect(supportBodyLimitBytes(20 * 1024 * 1024)).toBeGreaterThan(
      supportBodyLimitBytes(5 * 1024 * 1024),
    );
  });
});

describe('base64 validation', () => {
  const png = (data: string) => [{ filename: 'a.png', contentType: 'image/png', data }];

  it('rejects payloads that are not base64, rather than mailing garbage bytes', () => {
    // Buffer.from(x, 'base64') ignores anything outside the alphabet, so each of
    // these would otherwise decode to something and be delivered as a corrupt
    // file with no error raised.
    for (const bad of [
      'data:image/png;base64,aGVsbG8=', // a data: URL, as some clients send
      'not base64 at all!!',
      'aGVsbG8=extra',
      '@@@@',
      '   ',
    ]) {
      const result = validateSupportAttachments(png(bad), LIMITS);
      expect(result).toMatchObject({ ok: false, error: 'ATTACHMENT_INVALID_ENCODING' });
    }
  });

  it('names the offending file so the form can say which one', () => {
    const result = validateSupportAttachments(
      [{ filename: 'holiday snap.png', contentType: 'image/png', data: '@@@' }],
      LIMITS,
    );
    if (result.ok) throw new Error('expected a rejection');
    expect(result.message).toContain('holiday snap.png');
  });

  it('accepts base64 wrapped at column boundaries, and forwards it compacted', () => {
    // Wrapping every 76 chars is legitimate; the notification service validates
    // strictly, so what we forward must be canonical.
    const raw = Buffer.alloc(200, 9).toString('base64');
    const wrapped = raw.replace(/(.{40})/g, '$1\n');
    const result = validateSupportAttachments(png(wrapped), LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments[0].data).toBe(raw);
    expect(result.attachments[0].data).not.toContain('\n');
    expect(result.attachments[0].bytes).toBe(200);
  });

  it('validates a max-legal payload without backtracking over it', () => {
    // 5 MB of bytes is ~7 MB of base64. The grouped RFC-4648 pattern this check
    // replaced overflowed V8's regex stack on exactly this input, turning a
    // valid submission into a 500 — so the boundary is worth asserting.
    const max = Buffer.alloc(LIMITS.maxTotalBytes, 7).toString('base64');
    expect(validateSupportAttachments(png(max), LIMITS).ok).toBe(true);
  });
});
