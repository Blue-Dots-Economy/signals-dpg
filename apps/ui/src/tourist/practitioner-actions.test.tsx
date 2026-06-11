import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PractitionerActions } from './practitioner-actions';
import * as directions from '@/lib/geo/directions';

afterEach(() => vi.restoreAllMocks());

describe('PractitionerActions', () => {
  it('renders only the buttons whose data is present', () => {
    render(<PractitionerActions phone="9876543210" website={null} location={null} />);
    expect(screen.getByRole('link', { name: /call/i })).toHaveAttribute('href', 'tel:+919876543210');
    expect(screen.queryByRole('link', { name: /website/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /directions/i })).toBeNull();
  });

  it('website link opens a normalized URL in a new tab', () => {
    render(<PractitionerActions phone={null} website="coastalcrafts.in" location={null} />);
    const link = screen.getByRole('link', { name: /website/i });
    expect(link).toHaveAttribute('href', 'https://coastalcrafts.in');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('directions button calls openDirections with the location', async () => {
    const spy = vi.spyOn(directions, 'openDirections').mockImplementation(() => {});
    render(<PractitionerActions phone={null} website={null} location={{ lat: 1, lng: 2, label: 'X' }} />);
    await userEvent.click(screen.getByRole('button', { name: /directions/i }));
    expect(spy).toHaveBeenCalledWith({ lat: 1, lng: 2, label: 'X' }, 'X');
  });

  it('renders nothing when no data is present', () => {
    const { container } = render(<PractitionerActions phone={null} website={null} location={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
