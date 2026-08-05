import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain } from '@/engine/types';
import { ActionFiltersSheet } from '../action-filters-sheet';

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

describe('ActionFiltersSheet', () => {
  it('renders a facet group for a schema-declared enum field with its options', () => {
    render(
      <ActionFiltersSheet
        open
        domains={[domainWithPrivateField]}
        selected={{}}
        onChange={noop}
        actionTypes={[]}
        onActionTypesChange={noop}
        onClose={noop}
      />,
    );

    expect(screen.getByText('mentor')).toBeInTheDocument();
    expect(screen.getByText('peer')).toBeInTheDocument();
    expect(screen.getByText('internship')).toBeInTheDocument();
  });

  it('never renders a private field, under any label', () => {
    render(
      <ActionFiltersSheet
        open
        domains={[domainWithPrivateField]}
        selected={{}}
        onChange={noop}
        actionTypes={[]}
        onActionTypesChange={noop}
        onClose={noop}
      />,
    );

    expect(screen.queryByText(/phone/i)).not.toBeInTheDocument();
  });

  it('calls onChange with the value added under its field key when a facet option is checked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ActionFiltersSheet
        open
        domains={[domainWithPrivateField]}
        selected={{}}
        onChange={onChange}
        actionTypes={[]}
        onActionTypesChange={noop}
        onClose={noop}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: 'mentor' }));

    expect(onChange).toHaveBeenCalledWith({ looking_for: ['mentor'] });
  });

  it('calls onChange with the value removed when an already-checked facet option is unchecked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ActionFiltersSheet
        open
        domains={[domainWithPrivateField]}
        selected={{ looking_for: ['mentor', 'peer'] }}
        onChange={onChange}
        actionTypes={[]}
        onActionTypesChange={noop}
        onClose={noop}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: 'mentor' }));

    expect(onChange).toHaveBeenCalledWith({ looking_for: ['peer'] });
  });

  it('renders no distance filter and no PII section', () => {
    render(
      <ActionFiltersSheet
        open
        domains={[domainWithPrivateField]}
        selected={{}}
        onChange={noop}
        actionTypes={[]}
        onActionTypesChange={noop}
        onClose={noop}
      />,
    );

    expect(screen.queryByText(/distance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/personally identifiable/i)).not.toBeInTheDocument();
  });

  it('renders an Action type section with Connect/Apply checkboxes, kept separate from facet `selected`', async () => {
    const user = userEvent.setup();
    const onActionTypesChange = vi.fn();
    render(
      <ActionFiltersSheet
        open
        domains={[domainWithPrivateField]}
        selected={{}}
        onChange={noop}
        actionTypes={['connect']}
        onActionTypesChange={onActionTypesChange}
        onClose={noop}
      />,
    );

    const connectCheckbox = screen.getByRole('checkbox', { name: 'Connect' });
    const applyCheckbox = screen.getByRole('checkbox', { name: 'Apply' });
    expect(connectCheckbox).toHaveAttribute('data-state', 'checked');
    expect(applyCheckbox).toHaveAttribute('data-state', 'unchecked');

    await user.click(applyCheckbox);

    expect(onActionTypesChange).toHaveBeenCalledWith(['connect', 'apply']);
  });

  it('does not render anything when closed', () => {
    render(
      <ActionFiltersSheet
        open={false}
        domains={[domainWithPrivateField]}
        selected={{}}
        onChange={noop}
        actionTypes={[]}
        onActionTypesChange={noop}
        onClose={noop}
      />,
    );

    expect(screen.queryByText('mentor')).not.toBeInTheDocument();
  });
});
