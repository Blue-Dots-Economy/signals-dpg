import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { format } from 'date-fns';

/**
 * Drives the `DobCalendar` popover (shadcn `Calendar` + react-day-picker v10,
 * `captionLayout="dropdown"`) end-to-end in tests: opens the trigger button,
 * jumps the caption to the target year + month via the dropdown `<select>`s
 * react-day-picker renders (accessible names "Choose the Year" / "Choose the
 * Month"), then clicks the target day cell. Returns the picked `Date` so
 * callers can derive the birthYear/birthMonth a submission is expected to
 * carry.
 *
 * `month` is 1-indexed (matches `Date#getMonth() + 1`, which is how the app
 * itself derives birthMonth from the picked date — see dob-calendar.tsx
 * callers); it is converted to the picker's 0-indexed dropdown value here.
 */
export async function pickDob(
  triggerName: RegExp,
  year: number,
  month: number,
  day = 1,
): Promise<Date> {
  await userEvent.click(screen.getByRole('button', { name: triggerName }));
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: /choose the year/i }),
    String(year),
  );
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: /choose the month/i }),
    String(month - 1),
  );
  const date = new Date(year, month - 1, day);
  await userEvent.click(screen.getByRole('button', { name: format(date, 'PPPP') }));
  return date;
}

/**
 * Drives the `DobYearMonth` picker (#331): selects the birth year, and — only
 * for the boundary year (turns 18 this year), where the month select appears —
 * selects the month too. `month` is 1-indexed; ignored for non-boundary years.
 */
export async function pickYearMonthDob(year: number, month?: number): Promise<void> {
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: /birth year/i }),
    String(year),
  );
  const boundary = new Date().getFullYear() - 18;
  if (year === boundary && month !== undefined) {
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /birth month/i }),
      String(month),
    );
  }
}
