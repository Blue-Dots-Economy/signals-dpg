import { describe, expect, it } from 'vitest';
import {
  encodeAttachments,
  fileToBase64,
  formatBytes,
  matchesAllowedType,
  validateAttachmentSelection,
} from '../support-attachments';

const CONFIG = {
  maxFiles: 3,
  maxTotalBytes: 5 * 1024 * 1024,
  allowedTypes: ['image/png', 'image/jpeg', 'audio/mpeg'],
};

const file = (name: string, type: string, bytes = 64) =>
  new File([new Uint8Array(bytes)], name, { type });

describe('matchesAllowedType', () => {
  it('matches exact types, as served by the API', () => {
    expect(matchesAllowedType('image/png', CONFIG.allowedTypes)).toBe(true);
    expect(matchesAllowedType('image/gif', CONFIG.allowedTypes)).toBe(false);
  });

  it('matches wildcards, as used by the offline fallback config', () => {
    expect(matchesAllowedType('image/heic', ['image/*'])).toBe(true);
    expect(matchesAllowedType('video/mp4', ['image/*'])).toBe(false);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(matchesAllowedType(' IMAGE/PNG ', CONFIG.allowedTypes)).toBe(true);
  });

  it('rejects an empty type, which the browser gives for unknown files', () => {
    expect(matchesAllowedType('', ['image/*'])).toBe(false);
  });
});

describe('validateAttachmentSelection', () => {
  it('accepts a selection inside every limit', () => {
    const result = validateAttachmentSelection([], [file('a.png', 'image/png')], CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files).toHaveLength(1);
  });

  it('counts the existing selection, not just the new files', () => {
    const current = [file('a.png', 'image/png'), file('b.png', 'image/png')];
    const result = validateAttachmentSelection(
      current,
      [file('c.png', 'image/png'), file('d.png', 'image/png')],
      CONFIG,
    );
    expect(result).toMatchObject({ ok: false, reason: 'count' });
  });

  it('sums sizes across the whole selection', () => {
    const config = { ...CONFIG, maxTotalBytes: 4096 };
    const current = [file('a.png', 'image/png', 3000)];
    expect(
      validateAttachmentSelection(current, [file('b.png', 'image/png', 3000)], config),
    ).toMatchObject({ ok: false, reason: 'size' });
  });

  it('names the offending file when the type is wrong', () => {
    const result = validateAttachmentSelection([], [file('notes.pdf', 'application/pdf')], CONFIG);
    expect(result).toMatchObject({ ok: false, reason: 'type', filename: 'notes.pdf' });
  });

  it('reports count before type, matching the server ordering', () => {
    const result = validateAttachmentSelection(
      [],
      [
        file('a.pdf', 'application/pdf'),
        file('b.pdf', 'application/pdf'),
        file('c.pdf', 'application/pdf'),
        file('d.pdf', 'application/pdf'),
      ],
      CONFIG,
    );
    expect(result).toMatchObject({ ok: false, reason: 'count' });
  });
});

describe('fileToBase64', () => {
  it('round-trips content', async () => {
    const content = 'a tiny attachment';
    const encoded = await fileToBase64(new File([content], 'a.txt', { type: 'text/plain' }));
    expect(atob(encoded)).toBe(content);
  });

  it('encodes a payload larger than one chunk without overflowing the stack', async () => {
    // 0x8000 is the chunk size; go well past it.
    const bytes = new Uint8Array(200_000).fill(7);
    const encoded = await fileToBase64(new File([bytes], 'big.bin', { type: 'image/png' }));
    expect(encoded.length).toBe(Math.ceil(200_000 / 3) * 4);
    expect(atob(encoded).length).toBe(200_000);
  });
});

describe('encodeAttachments', () => {
  it('maps files to the request payload shape', async () => {
    const encoded = await encodeAttachments([file('a.png', 'image/png', 3)]);
    expect(encoded).toEqual([
      { filename: 'a.png', contentType: 'image/png', data: 'AAAA' },
    ]);
  });

  it('substitutes a concrete content type when the browser gives none', async () => {
    const encoded = await encodeAttachments([file('mystery', '', 3)]);
    expect(encoded[0].contentType).toBe('application/octet-stream');
  });
});

describe('formatBytes', () => {
  it('matches the API formatting so both messages read the same', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
