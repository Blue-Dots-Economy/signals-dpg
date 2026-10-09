import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain } from '@/engine/types';
import { BrowseFiltersPanel } from './browse-filters-panel';

// #394: the MAP (`viewMode="map"`) and the LIST offer the SAME facet set —
// every declared, non-private enum field for these unmarked schemas (a schema
// using the infra#57 `filterable` marker narrows both alike). A single domain
// (`domains.length === 1`) also hides the domain chip group, isolating these
// assertions to the enum-field behavior. See #360 for the proper long-term
// schema-driven search/filter declaration.
function domainWithPlainEnum(): DotNetworkDomain {
  return {
    id: 'seeker',
    description: 'seeker',
    item_schemas: {
      'profile_1.0': {
        type: 'object',
        properties: {
          preferred_language: { type: 'string', enum: ['en', 'hi', 'kn'] },
        },
      } as RJSFSchema,
    },
  } as DotNetworkDomain;
}

describe('BrowseFiltersPanel — same enum-field set on map and list (#394)', () => {
  it('renders the Filters trigger on the MAP for a plain (non-private) enum field with no filterable marker', () => {
    const domain = domainWithPlainEnum();
    render(
      <BrowseFiltersPanel
        domains={[domain]}
        selectedFields={{}}
        onFieldsChange={() => {}}
        viewMode="map"
      />,
    );
    expect(screen.getByRole('button', { name: /filters/i })).toBeInTheDocument();
  });

  it('renders the Filters trigger on the LIST for that same enum field (no regression)', () => {
    const domain = domainWithPlainEnum();
    render(
      <BrowseFiltersPanel
        domains={[domain]}
        selectedFields={{}}
        onFieldsChange={() => {}}
        viewMode="list"
      />,
    );
    expect(screen.getByRole('button', { name: /filters/i })).toBeInTheDocument();
  });

  it('renders nothing when the only enum field is `private: true` (the one remaining, security-motivated gate)', () => {
    const domain: DotNetworkDomain = {
      id: 'seeker',
      description: 'seeker',
      item_schemas: {
        'profile_1.0': {
          type: 'object',
          properties: {
            ssn_last_four: { type: 'string', enum: ['1234', '5678'], private: true },
          },
        } as RJSFSchema,
      },
    } as DotNetworkDomain;

    const { container } = render(
      <BrowseFiltersPanel
        domains={[domain]}
        selectedFields={{}}
        onFieldsChange={() => {}}
        viewMode="map"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
