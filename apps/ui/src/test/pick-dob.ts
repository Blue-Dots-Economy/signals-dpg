import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Drives the `BirthYearSelect` picker (#331): selects the birth year. The UI
 * collects the year only (no month/day); the component derives the age snapshot
 * (`currentYear - birthYear`) the submission carries.
 */
export async function pickBirthYear(year: number): Promise<void> {
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: /birth year/i }),
    String(year),
  );
}
