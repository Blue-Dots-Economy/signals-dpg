import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Drives the `BirthYearSelect` picker (#331): selects the birth year. The UI
 * collects the year only (no month/day); the component derives the age snapshot
 * (`currentYear - birthYear`) the submission carries.
 *
 * The control is the app's Select (a button plus a portalled listbox), not a
 * native `<select>` — 121 native options rendered as one window-tall column
 * with no usable scrollbar. So this opens the trigger and clicks the option
 * rather than calling `selectOptions`.
 */
export async function pickBirthYear(year: number): Promise<void> {
  const trigger = screen.getByRole('combobox', { name: /birth year/i });
  await userEvent.click(trigger);
  const listbox = await screen.findByRole('listbox');
  await userEvent.click(within(listbox).getByRole('option', { name: String(year) }));
}
