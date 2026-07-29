import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain } from '@/engine/types';
import { MapFiltersPanel } from './map-filters-panel';

// #203 map-serverside-search Task 7 review fix: the server's facet guard
// (`resolveAllowedFacetFields`, Task 3) only honors fields declared
// `filterable: true` in network.json (Task 1) — a plain enum field is a
// normal form field the server silently drops as a MAP facet filter. The
// panel must therefore only OFFER filterable facets when `viewMode="map"`,
// while still offering every enum facet when `viewMode="list"` (no
// regression — the list filters client-side and needs no server
// cooperation). A single domain (`domains.length === 1`) also hides the
// domain chip group, isolating these assertions to the enum-field behavior.
function domainWithNonFilterableEnum(): DotNetworkDomain {
  return {
    id: 'seeker',
    description: 'seeker',
    item_schemas: {
      'profile_1.0': {
        type: 'object',
        properties: {
          // No `filterable` marker at all — offered to the LIST, not the MAP.
          preferred_language: { type: 'string', enum: ['en', 'hi', 'kn'] },
        },
      } as RJSFSchema,
    },
  } as DotNetworkDomain;
}

describe('MapFiltersPanel — filterableOnly by viewMode (#203 Task 7 review fix)', () => {
  it('renders nothing on the MAP when the only enum field is non-filterable (no facets to offer)', () => {
    const domain = domainWithNonFilterableEnum();
    const { container } = render(
      <MapFiltersPanel
        domains={[domain]}
        selectedDomains={[]}
        onDomainsChange={() => {}}
        selectedFields={{}}
        onFieldsChange={() => {}}
        viewMode="map"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the Filters trigger on the LIST for that same non-filterable enum field (no regression)', () => {
    const domain = domainWithNonFilterableEnum();
    render(
      <MapFiltersPanel
        domains={[domain]}
        selectedDomains={[]}
        onDomainsChange={() => {}}
        selectedFields={{}}
        onFieldsChange={() => {}}
        viewMode="list"
      />,
    );
    expect(screen.getByRole('button', { name: /filters/i })).toBeInTheDocument();
  });

  it('renders the Filters trigger on the MAP once at least one field is declared filterable', () => {
    const domain: DotNetworkDomain = {
      id: 'seeker',
      description: 'seeker',
      item_schemas: {
        'profile_1.0': {
          type: 'object',
          properties: {
            gender: { type: 'string', enum: ['female', 'male'], filterable: true },
          },
        } as RJSFSchema,
      },
    } as DotNetworkDomain;

    render(
      <MapFiltersPanel
        domains={[domain]}
        selectedDomains={[]}
        onDomainsChange={() => {}}
        selectedFields={{}}
        onFieldsChange={() => {}}
        viewMode="map"
      />,
    );
    expect(screen.getByRole('button', { name: /filters/i })).toBeInTheDocument();
  });
});
