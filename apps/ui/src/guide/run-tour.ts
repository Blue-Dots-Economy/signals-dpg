import { driver, type DriveStep, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import './guide.css';
import type { GuideTour } from './tours';

/**
 * Plays a tour on the live page with Driver.js. SPIKE.
 *
 * Steps whose anchor is not on the page are dropped rather than shown pointing
 * at nothing: the same tour then works on mobile (sidebar collapsed), signed in
 * or out, and across page states.
 */

/** Give up waiting for anchors after this long and play what is there. */
const WAIT_MS = 6000;
/** After this long, settle for any anchor rather than all of them. */
const GRACE_MS = 1500;
const POLL_MS = 150;

let active: Driver | null = null;
let starting = false;

/** True while a tour is waiting to start or on screen. */
export function isTourRunning(): boolean {
  return starting || active !== null;
}

export async function runTour(tour: GuideTour): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    active?.destroy();
    // Pages render their content after data loads, so wait for the tour's
    // anchors to appear before deciding which steps to keep.
    if (tour.readyWhen) {
      const ready = tour.readyWhen;
      // A tour that needs another view switches to it the way a user would,
      // once the switch control itself has rendered.
      if (tour.prepare && !isVisible(ready)) {
        await waitFor(() => isVisible(ready) || isVisible(tour.prepare!), WAIT_MS);
        if (!isVisible(ready)) document.querySelector<HTMLElement>(tour.prepare)?.click();
      }
      await waitFor(() => isVisible(ready), WAIT_MS);
    }
    await waitForAnyAnchor(tour);

    const steps: DriveStep[] = tour.steps.flatMap((s) => {
      const element = firstVisible(s.element);
      if (s.element && !element && !s.keep) return [];
      return [{ element, popover: { title: s.title, description: s.description } }];
    });
    if (steps.length === 0) return;

    active = driver({
      steps,
      showProgress: true,
      allowClose: true,
      overlayOpacity: 0.55,
      stagePadding: 6,
      stageRadius: 8,
      popoverClass: 'signals-guide',
      onDestroyed: () => {
        active = null;
      },
    });
    active.drive();
  } finally {
    starting = false;
  }
}

async function waitForAnyAnchor(tour: GuideTour): Promise<void> {
  // One entry per anchored step: a step is satisfied by any of its selectors.
  const selectors = tour.steps.flatMap((s) => (s.element ? [[s.element].flat().join(', ')] : []));
  if (selectors.length === 0) return;
  // Wait for every anchor, but a page state that lacks some of them (an empty
  // list, the role picker) settles for any anchor after a short grace period.
  const startedAt = Date.now();
  while (Date.now() - startedAt < WAIT_MS) {
    if (selectors.every(isVisible)) return;
    if (Date.now() - startedAt > GRACE_MS && selectors.some(isVisible)) return;
    await sleep(POLL_MS); // NOSONAR — polling: each check must wait for the last
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const startedAt = Date.now();
  while (!check() && Date.now() - startedAt < ms) {
    await sleep(POLL_MS); // NOSONAR — polling: each check must wait for the last
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function firstVisible(element: string | string[] | undefined): string | undefined {
  return [element ?? []].flat().find(isVisible);
}

function isVisible(selector: string): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

const SEEN_PREFIX = 'signals-guide:seen:';

export function hasSeenTour(id: string): boolean {
  try {
    return localStorage.getItem(SEEN_PREFIX + id) !== null;
  } catch {
    return true; // storage blocked: never auto-start rather than nag every visit
  }
}

export function markTourSeen(id: string): void {
  try {
    localStorage.setItem(SEEN_PREFIX + id, new Date().toISOString());
  } catch {
    /* storage blocked — ignore */
  }
}
