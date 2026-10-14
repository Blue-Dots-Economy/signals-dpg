import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExportButtons } from '../export-buttons';

// #771 UX: one Download button per counterparty type, in the bulk bar.

describe('ExportButtons', () => {
  it('renders nothing when no exportable card is selected', () => {
    const { container } = render(<ExportButtons groups={[]} onDownload={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('one type → one button labelled with the type', () => {
    const onDownload = vi.fn();
    render(<ExportButtons groups={[{ key: 'seeker::p', label: 'Seekers', count: 3 }]} onDownload={onDownload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download Seekers (3)' }));
    expect(onDownload).toHaveBeenCalledWith('seeker::p');
  });

  it('several types → a separate button for each', () => {
    const onDownload = vi.fn();
    render(
      <ExportButtons
        groups={[
          { key: 'provider::p', label: 'Service Providers', count: 1 },
          { key: 'seeker::p', label: 'Seekers', count: 2 },
        ]}
        onDownload={onDownload}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download Seekers (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download Service Providers (1)' }));
    expect(onDownload.mock.calls).toEqual([['seeker::p'], ['provider::p']]);
  });

  it('disables every button while a download runs', () => {
    render(
      <ExportButtons
        groups={[
          { key: 'a', label: 'Seekers', count: 1 },
          { key: 'b', label: 'Providers', count: 1 },
        ]}
        pending
        onDownload={vi.fn()}
      />,
    );
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
  });
});
