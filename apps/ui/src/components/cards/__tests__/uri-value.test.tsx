import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UriValue } from '../uri-value';

describe('UriValue', () => {
  it('renders a safe link with the value as its text', () => {
    render(<UriValue value="https://example.com" />);
    const link = screen.getByRole('link', { name: 'https://example.com' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('prefixes a scheme-less value in the href but shows it as typed', () => {
    render(<UriValue value="example.com" />);
    const link = screen.getByRole('link', { name: 'example.com' });
    expect(link).toHaveAttribute('href', 'https://example.com');
  });

  it('renders a masked value as plain text, not a link', () => {
    render(<UriValue value="https://***" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('https://***')).toBeInTheDocument();
  });

  it('renders an unlinkable value as plain text', () => {
    render(<UriValue value="companyabc" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('companyabc')).toBeInTheDocument();
  });

  it('renders each entry of an array as its own link', () => {
    render(<UriValue value={['https://a.com', 'https://b.com']} />);
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('elides long display text but keeps the full href', () => {
    const long = `https://example.com/${'a'.repeat(120)}`;
    render(<UriValue value={long} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', long);
    expect(link).toHaveAttribute('title', long);
    expect(link.textContent!.length).toBeLessThan(long.length);
    expect(link.textContent!.endsWith('…')).toBe(true);
  });

  it('renders an em dash for an empty value', () => {
    render(<UriValue value={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
