import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExportMenu } from '../export-menu';

// #771 UX: the single Download control in the bulk bar.

describe('ExportMenu', () => {
  it('renders nothing when no exportable card is selected', () => {
    const { container } = render(<ExportMenu groups={[]} onDownload={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('one counterparty type → one button that downloads straight away', async () => {
    const onDownload = vi.fn();
    render(
      <ExportMenu groups={[{ key: 'seeker::p', label: 'Seekers', count: 3 }]} onDownload={onDownload} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Download (3)' }));
    expect(onDownload).toHaveBeenCalledWith('seeker::p');
  });

  it('several types → one button with a menu, one item per type', async () => {
    const onDownload = vi.fn();
    render(
      <ExportMenu
        groups={[
          { key: 'provider::p', label: 'Service Providers', count: 1 },
          { key: 'seeker::p', label: 'Seekers', count: 2 },
        ]}
        onDownload={onDownload}
      />,
    );
    // Total on the trigger; the bar never grows with more types.
    await userEvent.click(screen.getByRole('button', { name: 'Download (3)' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Seekers (2)' }));
    expect(onDownload).toHaveBeenCalledWith('seeker::p');
  });

  it('is disabled while a download runs', () => {
    render(
      <ExportMenu groups={[{ key: 'seeker::p', label: 'Seekers', count: 1 }]} pending onDownload={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /download/i })).toBeDisabled();
  });
});
