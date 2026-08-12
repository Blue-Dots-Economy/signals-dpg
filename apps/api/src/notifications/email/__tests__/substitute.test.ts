import { describe, expect, it } from 'vitest';
import { escapeHtml, substituteHtml, substitutePlain } from '../substitute';

describe('escapeHtml', () => {
  it('escapes & < > " \'', () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;',
    );
  });
});

describe('substituteHtml', () => {
  it('escapes text tokens (XSS acceptance test)', () => {
    const out = substituteHtml(
      '<p>{{name}} says hi</p>',
      { name: '<script>alert(1)</script>' },
      { name: 'text' },
    );
    expect(out).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; says hi</p>');
  });

  it('preserves inline HTML in the trusted template', () => {
    const out = substituteHtml('<p><b>{{name}}</b></p>', { name: 'Anu' }, { name: 'text' });
    expect(out).toBe('<p><b>Anu</b></p>');
  });

  it('inserts html tokens raw', () => {
    const out = substituteHtml('{{orgList}}', { orgList: '<ol><li>A</li></ol>' }, { orgList: 'html' });
    expect(out).toBe('<ol><li>A</li></ol>');
  });

  it('leaves undeclared tokens verbatim (typos are visible, not fatal)', () => {
    const out = substituteHtml('<p>{{otpp}}</p>', { otp: '123456' }, { otp: 'text' });
    expect(out).toBe('<p>{{otpp}}</p>');
  });

  it('leaves declared-but-unprovided tokens verbatim', () => {
    const out = substituteHtml('<p>{{name}}</p>', {}, { name: 'text' });
    expect(out).toBe('<p>{{name}}</p>');
  });

  it('replaces repeated tokens everywhere', () => {
    const out = substituteHtml('{{org}} and {{org}}', { org: 'A&B' }, { org: 'text' });
    expect(out).toBe('A&amp;B and A&amp;B');
  });

  it('leaves a prototype-chain placeholder name verbatim instead of throwing', () => {
    // {{constructor}} resolves via Object.prototype under plain `in`/indexed
    // lookups (to a function), which would then blow up escapeHtml. It must
    // be treated as undeclared/unprovided, like any other typo'd token.
    const out = substituteHtml('<p>{{constructor}}</p>', {}, { otp: 'text' });
    expect(out).toBe('<p>{{constructor}}</p>');
  });
});

describe('substitutePlain', () => {
  it('substitutes without escaping (subjects are not HTML)', () => {
    const out = substitutePlain('Sent to {{name}}', { name: "R&D <dept>" }, { name: 'text' });
    expect(out).toBe('Sent to R&D <dept>');
  });
});
