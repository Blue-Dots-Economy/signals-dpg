import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PractitionerCard } from './practitioner-card';

const data = {
  name: 'Coastal Crafts',
  contact_phone: '9876543210',
  website: 'coastalcrafts.in',
  item_locations: [{ lat: 13.34, lng: 74.74, label: 'Udupi' }],
};

describe('PractitionerCard', () => {
  it('renders the practitioner name and all three actions', () => {
    render(<PractitionerCard data={data} schema={null} variant="popup" />);
    expect(screen.getAllByText('Coastal Crafts').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /call/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /explore/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /directions/i })).toBeInTheDocument();
  });

  it('omits actions for missing fields', () => {
    render(<PractitionerCard data={{ name: 'No Contact', item_locations: [] }} schema={null} variant="popup" />);
    expect(screen.queryByRole('link', { name: /call/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /directions/i })).toBeNull();
  });
});
