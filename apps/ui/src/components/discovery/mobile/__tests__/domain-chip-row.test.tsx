import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DomainChipRow } from '../domain-chip-row';

const options = [
  { id: 'seeker', label: 'Seeker', pluralLabel: 'Seekers' },
  { id: 'provider', label: 'Provider', pluralLabel: 'Providers' },
];

describe('DomainChipRow', () => {
  it('labels the chips by the plural domain name inside a labelled group', () => {
    render(<DomainChipRow options={options} selected={[]} showAll onSelect={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Domain' });
    expect(group).toHaveTextContent('AllSeekersProviders');
  });

  it('presses only All when nothing is narrowed', () => {
    render(<DomainChipRow options={options} selected={[]} showAll onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Seekers' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('presses All, not every chip, when every domain is selected', () => {
    render(<DomainChipRow options={options} selected={['seeker', 'provider']} showAll onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Providers' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('presses the one selected domain', () => {
    render(<DomainChipRow options={options} selected={['provider']} showAll onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Providers' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('omits All when the caller does not offer it (the single-domain list)', () => {
    render(<DomainChipRow options={options} selected={['seeker']} showAll={false} onSelect={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Seekers' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('reports a domain id, or null for All', async () => {
    const onSelect = vi.fn();
    render(<DomainChipRow options={options} selected={['seeker']} showAll onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Providers' }));
    expect(onSelect).toHaveBeenLastCalledWith('provider');
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('renders nothing when there is only one domain to browse', () => {
    const { container } = render(
      <DomainChipRow options={[options[0]]} selected={[]} showAll onSelect={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('meets the 44px touch target', () => {
    render(<DomainChipRow options={options} selected={[]} showAll onSelect={vi.fn()} />);
    for (const chip of screen.getAllByRole('button')) expect(chip).toHaveClass('h-11');
  });
});
