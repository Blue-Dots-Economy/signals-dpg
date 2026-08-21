import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { resolveCardFields } from '../resolve-card-fields';
import { ItemCard } from '../item-card';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}));

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name' },
    site: { type: 'string', title: 'Site', 'x-uri': true },
    notes: { type: 'string', title: 'Notes' },
  },
} as never;

describe('resolveCardFields marks x-uri rows', () => {
  it('sets isUri on a marked field and not on others', () => {
    const resolved = resolveCardFields(schema, {
      name: 'Asha',
      site: 'https://example.com',
      notes: 'hello',
    });
    const rows = [...resolved.defaultRows, ...resolved.extraRows];
    expect(rows.find((r) => r.key === 'site')?.isUri).toBe(true);
    expect(rows.find((r) => r.key === 'name')?.isUri).toBe(false);
    expect(rows.find((r) => r.key === 'notes')?.isUri).toBe(false);
  });
});

describe('ItemCard renders x-uri rows as links', () => {
  it('renders a flagged field as a hyperlink', () => {
    render(<ItemCard schema={schema} data={{ name: 'Asha', site: 'https://example.com' }} />);
    const link = screen.getByRole('link', { name: 'https://example.com' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('leaves non-flagged fields as plain text', () => {
    render(
      <ItemCard schema={schema} data={{ name: 'Asha', notes: 'https://example.com' }} />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('https://example.com')).toBeInTheDocument();
  });

  it('does not link a masked value', () => {
    render(<ItemCard schema={schema} data={{ name: 'Asha', site: 'https://***' }} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('does not fire the card onClick when the link is followed', () => {
    const onClick = vi.fn();
    render(
      <ItemCard
        schema={schema}
        data={{ name: 'Asha', site: 'https://example.com' }}
        onClick={onClick}
      />,
    );
    screen.getByRole('link').click();
    expect(onClick).not.toHaveBeenCalled();
  });
});
