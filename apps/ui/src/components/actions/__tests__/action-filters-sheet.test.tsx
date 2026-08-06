import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain } from '@/engine/types';
import { ActionFiltersSheet, type ActionFiltersSheetProps } from '../action-filters-sheet';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, defaultValue?: string) => defaultValue ?? key }),
}));

// Fake counterparty domain: a `looking_for` enum facet (should render) and a
// `private: true` `phone` field (must never render, anywhere — not even as a
// disabled/hidden-but-present group), matching the #394 defense-in-depth rule
// that `getEnumFilterFieldsForDomains` already enforces.
const domainWithPrivateField: DotNetworkDomain = {
  id: 'seeker',
  description: 'Seeker',
  item_schemas: {
    profile_1: {
      type: 'object',
      properties: {
        looking_for: { type: 'array', items: { enum: ['mentor', 'peer', 'internship'] } },
        phone: { type: 'string', private: true },
      },
    } as RJSFSchema,
  },
};

function noop() {}

const defaults: ActionFiltersSheetProps = {
  open: true,
  domains: [domainWithPrivateField],
  selected: {},
  onChange: noop,
  status: 'All',
  onStatusChange: noop,
  actionTypes: [],
  onActionTypesChange: noop,
  onClose: noop,
};

const renderSheet = (overrides: Partial<ActionFiltersSheetProps> = {}) =>
  render(<ActionFiltersSheet {...defaults} {...overrides} />);

describe('ActionFiltersSheet', () => {
  it('renders a facet group for a schema-declared enum field with its options', () => {
    renderSheet();
    expect(screen.getByText('mentor')).toBeInTheDocument();
    expect(screen.getByText('peer')).toBeInTheDocument();
    expect(screen.getByText('internship')).toBeInTheDocument();
  });

  it('never renders a private field, under any label', () => {
    renderSheet();
    expect(screen.queryByText(/phone/i)).not.toBeInTheDocument();
  });

  it('calls onChange with the value added under its field key when a facet option is checked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSheet({ onChange });
    await user.click(screen.getByRole('checkbox', { name: 'mentor' }));
    expect(onChange).toHaveBeenCalledWith({ looking_for: ['mentor'] });
  });

  it('calls onChange with the value removed when an already-checked facet option is unchecked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSheet({ selected: { looking_for: ['mentor', 'peer'] }, onChange });
    await user.click(screen.getByRole('checkbox', { name: 'mentor' }));
    expect(onChange).toHaveBeenCalledWith({ looking_for: ['peer'] });
  });

  it('renders a single-select Status section and reports the chosen status', async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn();
    renderSheet({ status: 'All', onStatusChange });

    // All four status options present, driven by props (not internal state).
    expect(screen.getByTestId('status-option-All')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('status-option-Pending')).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByTestId('status-option-Accepted'));
    expect(onStatusChange).toHaveBeenCalledWith('Accepted');
  });

  it('renders no distance filter and no PII section', () => {
    renderSheet();
    expect(screen.queryByText(/distance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/personally identifiable/i)).not.toBeInTheDocument();
  });

  it('renders an Action type section with Connect/Apply checkboxes, kept separate from facet `selected`', async () => {
    const user = userEvent.setup();
    const onActionTypesChange = vi.fn();
    renderSheet({ actionTypes: ['connect'], onActionTypesChange });

    const connectCheckbox = screen.getByRole('checkbox', { name: 'Connect' });
    const applyCheckbox = screen.getByRole('checkbox', { name: 'Apply' });
    expect(connectCheckbox).toHaveAttribute('data-state', 'checked');
    expect(applyCheckbox).toHaveAttribute('data-state', 'unchecked');

    await user.click(applyCheckbox);
    expect(onActionTypesChange).toHaveBeenCalledWith(['connect', 'apply']);
  });

  it('does not render anything when closed', () => {
    renderSheet({ open: false });
    expect(screen.queryByText('mentor')).not.toBeInTheDocument();
  });
});
