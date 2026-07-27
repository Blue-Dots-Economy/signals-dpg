import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ConsentModal } from '../consent-modal';

vi.mock('@/theme/theme-provider', () => ({ useNetworkTheme: () => ({ theme: { name: 'Test' } }) }));

const cfg = {
  documents: {
    privacy: { current_version: 1, versions: [{ version: 1, content: 'p' }] },
    terms: { current_version: 1, versions: [{ version: 1, content: 't' }] },
  },
} as never;

describe('ConsentModal viewport safety', () => {
  it('caps height with dvh (not vh) so the accept button stays reachable', () => {
    const { container } = render(
      <ConsentModal open mode="gate" initialTab="privacy" config={cfg} onAccept={() => {}} />,
    );
    const content = container.ownerDocument.querySelector('[data-slot="dialog-content"]');
    expect(content?.className).toMatch(/max-h-\[\d+dvh\]/);
    expect(content?.className).not.toMatch(/max-h-\[\d+vh\]/);
  });
});
