import { describe, expect, it } from 'vitest';
import {
  renderCtaShell,
  renderOrgList,
  renderOtpBox,
  renderPlainShell,
  renderSiteLink,
} from '../shells';

describe('renderCtaShell', () => {
  const args = {
    introHtml: '<p>Custom <b>body</b></p>',
    ctaUrl: 'https://x.example/auth/login',
    ctaLabel: 'View "details"',
    ctaColor: '#2563eb',
    brandName: 'Blue <Dot>',
  };

  it('inserts the body raw and escapes url/label/brand', () => {
    const html = renderCtaShell(args);
    expect(html).toContain('<p>Custom <b>body</b></p>');
    expect(html).not.toContain('<p><p>'); // no double wrapping
    expect(html).toContain('View &quot;details&quot;');
    expect(html).toContain('Team Blue &lt;Dot&gt;');
    expect(html).toContain('background-color:#2563eb');
    expect(html).toContain('href="https://x.example/auth/login"');
  });
});

describe('renderPlainShell', () => {
  it('wraps the body in the font div only', () => {
    const html = renderPlainShell('<p>hello</p>');
    expect(html).toContain('font-family: Arial');
    expect(html).toContain('<p>hello</p>');
  });
});

describe('renderOtpBox', () => {
  it('escapes the code and uses the monospace box', () => {
    const html = renderOtpBox('12<34');
    expect(html).toContain('12&lt;34');
    expect(html).toContain('Courier New');
  });
});

describe('renderSiteLink', () => {
  it('renders a clickable, escaped anchor when a URL is configured', () => {
    expect(renderSiteLink('https://x.example/?a=1&b=2')).toBe(
      '<a href="https://x.example/?a=1&amp;b=2">https://x.example/?a=1&amp;b=2</a>',
    );
  });

  it('degrades to plain words when no URL is configured (no dead anchor)', () => {
    for (const value of [undefined, '']) {
      const out = renderSiteLink(value);
      expect(out).toBe('the platform');
      expect(out).not.toContain('<a');
    }
  });
});

describe('renderOrgList', () => {
  it('renders an ordered list of escaped names', () => {
    expect(renderOrgList(['A&B', 'C'])).toBe('<ol><li>A&amp;B</li><li>C</li></ol>');
  });
  it('falls back for an empty list', () => {
    expect(renderOrgList([])).toBe('<p>the selected organisations</p>');
  });
});
