import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TouristList } from './tourist-list';
import type { CardItem } from './practitioner-data';

const near: CardItem = { id: 'near', domain: 'practitioner', data: { name: 'Near', item_locations: [{ lat: 13.34, lng: 74.74 }] } };
const far: CardItem = { id: 'far', domain: 'practitioner', data: { name: 'Far', item_locations: [{ lat: 19.0, lng: 72.8 }] } };

describe('TouristList', () => {
  it('orders nearest-first when a user location is provided', () => {
    render(<TouristList items={[far, near]} schema={null} cardConfig={null} userLocation={{ lat: 13.35, lng: 74.75 }} />);
    const names = screen.getAllByText(/Near|Far/).map((el) => el.textContent);
    expect(names[0]).toBe('Near');
  });

  it('renders an empty state when there are no items', () => {
    render(<TouristList items={[]} schema={null} cardConfig={null} userLocation={null} />);
    expect(screen.getByText(/no practitioners/i)).toBeInTheDocument();
  });
});
