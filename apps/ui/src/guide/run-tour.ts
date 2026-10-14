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

const STAGE_PADDING = 6;
const STAGE_RADIUS = 8;

/**
 * A ring in the brand colour around the highlighted element. The dimmed
 * overlay alone does not show it on a dark page — the lit cut-out looks like
 * its dark surroundings. A separate fixed element (not an outline on the
 * element itself), so a parent's overflow can never clip it; it follows the
 * element while the page scrolls or resizes.
 */
const ring = (() => {
  let node: HTMLDivElement | null = null;
  let target: Element | null = null;
  const place = () => {
    if (!node || !target) return;
    const r = target.getBoundingClientRect();
    Object.assign(node.style, {
      top: `${r.top - STAGE_PADDING}px`,
      left: `${r.left - STAGE_PADDING}px`,
      width: `${r.width + STAGE_PADDING * 2}px`,
      height: `${r.height + STAGE_PADDING * 2}px`,
    });
  };
  return {
    show(el: Element | undefined) {
      // A step with no element is a centred card: Driver.js stands in a
      // zero-size dummy, which gets no ring.
      if (!el || el.id === 'driver-dummy-element') return this.hide();
      if (!node) {
        node = document.createElement('div');
        node.className = 'signals-guide-ring';
        node.style.borderRadius = `${STAGE_RADIUS}px`;
        document.body.appendChild(node);
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
      }
      target = el;
      place();
    },
    hide() {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      node?.remove();
      node = null;
      target = null;
    },
  };
})();
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
      return [
        {
          // Picked again when the step is shown: an element listed first may
          // have rendered since the tour started (the bell, a profile's
          // status), and it is the better target.
          element: element ? () => (pick(firstVisible(s.element) ?? element) ?? pick(element))! : undefined,
          popover: { title: s.title, description: s.description },
        },
      ];
    });
    if (steps.length === 0) return;

    const dark = document.documentElement.classList.contains('dark');
    active = driver({
      steps,
      showProgress: true,
      allowClose: true,
      // A deeper veil on a dark page, so the lit element stands out.
      overlayOpacity: dark ? 0.75 : 0.55,
      stagePadding: STAGE_PADDING,
      stageRadius: STAGE_RADIUS,
      popoverClass: 'signals-guide',
      onHighlighted: (el) => ring.show(el),
      onDeselected: () => ring.hide(),
      onDestroyed: () => {
        ring.hide();
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
  return pick(selector) !== null;
}

function hasSize(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function onScreen(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

/**
 * The element a selector stands for: of everything it matches, the first one
 * on screen (a pin inside the map's view, not one panned away), else the first
 * with any size — Driver.js scrolls that one into view.
 */
function pick(selector: string): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(selector)].filter(
    (el) => hasSize(el) && reachable(el),
  );
  return all.find(onScreen) ?? all[0] ?? null;
}

/**
 * Inside the map, only what the map is showing counts: a pin panned out of
 * view has a size but cannot be scrolled to, so it must sit within the map.
 */
function reachable(el: Element): boolean {
  const map = el.closest('[data-tour="map"]');
  if (!map || map === el) return true;
  const m = map.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.bottom > m.top && r.top < m.bottom && r.right > m.left && r.left < m.right;
}

const SEEN_PREFIX = 'signals-guide:seen:';

/**
 * Seen records are per signed-in person (`<prefix><userId>:<tour>`), not per
 * browser: on a shared phone each person gets their own first-login tours,
 * and a visitor's records (no user id) never hide a member's.
 */
function seenKey(id: string, userId: string | undefined): string {
  return SEEN_PREFIX + (userId ? `${userId}:` : '') + id;
}

export function hasSeenTour(id: string, userId?: string): boolean {
  try {
    return localStorage.getItem(seenKey(id, userId)) !== null;
  } catch {
    return true; // storage blocked: never auto-start rather than nag every visit
  }
}

export function markTourSeen(id: string, userId?: string): void {
  try {
    localStorage.setItem(seenKey(id, userId), new Date().toISOString());
  } catch {
    /* storage blocked — ignore */
  }
}
