import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExportButtons } from '../export-buttons';

// #771: the My Actions download control.

describe('ExportButtons', () => {
  it('nothing selected → one disabled Download with a hint', () => {
    render(<ExportButtons groups={[]} onDownload={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /download/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Select at least one engagement to download');
  });

  it('one counterparty type → a single Download (N)', () => {
    const onDownload = vi.fn();
    render(
      <ExportButtons groups={[{ key: 'seeker::profile', label: 'Seekers', count: 3 }]} onDownload={onDownload} />,
    );
    const btn = screen.getByRole('button', { name: 'Download (3)' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onDownload).toHaveBeenCalledWith('seeker::profile');
  });

  it('several types → one button per type', () => {
    const onDownload = vi.fn();
    render(
      <ExportButtons
        groups={[
          { key: 'provider::profile', label: 'Providers', count: 2 },
          { key: 'seeker::profile', label: 'Seekers', count: 3 },
        ]}
        onDownload={onDownload}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download Providers (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download Seekers (3)' }));
    expect(onDownload.mock.calls).toEqual([['provider::profile'], ['seeker::profile']]);
  });

  it('disables every button while a download runs', () => {
    render(
      <ExportButtons
        groups={[{ key: 'seeker::profile', label: 'Seekers', count: 1 }]}
        pending
        onDownload={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /download/i })).toBeDisabled();
  });
});
