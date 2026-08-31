import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Toaster, toast } from 'sonner';

// Guards the `toast.dismiss()` teardown in `src/test/setup.ts`.
//
// sonner's queue lives in a module-level singleton, so RTL's `cleanup()` —
// which only unmounts the `<Toaster />` — leaves it untouched. Since sonner
// 2.0.8 a subscribing Toaster replays every still-active toast, so an
// undismissed toast from one test reappears in the next one's DOM and breaks
// unrelated `queryByText(...).not.toBeInTheDocument()` assertions.
//
// These two tests must stay in this order: the first leaves a toast behind,
// the second asserts the teardown cleared it. Asserting on `toast.getToasts()`
// (the active set) rather than only on the DOM makes this fail on pre-2.0.8
// sonner too, where there is no replay to surface the leak visually.
describe('toast state is isolated between tests', () => {
  it('leaves an undismissed toast behind on purpose', async () => {
    render(<Toaster />);
    toast.error('leaked-toast-marker');

    expect(await screen.findByText('leaked-toast-marker')).toBeInTheDocument();
    expect(toast.getToasts()).not.toHaveLength(0);
  });

  it('starts with an empty toast queue despite the previous test', () => {
    expect(toast.getToasts()).toHaveLength(0);

    render(<Toaster />);
    expect(screen.queryByText('leaked-toast-marker')).not.toBeInTheDocument();
  });
});
