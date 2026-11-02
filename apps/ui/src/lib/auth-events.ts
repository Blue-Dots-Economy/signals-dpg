/**
 * One-shot "the session is really gone" signal.
 *
 * An emitter because the detector (`api-client.ts`, an axios instance) has no
 * React context, while the reactor (`auth-context.tsx`) owns the `user` state
 * and the QueryClient, which `main.tsx` creates rather than exporting as a
 * module global.
 *
 * Fires once per page lifetime: several queries poll `/api/v1/action/fetch`
 * (`use-actions.ts`), so one expiry arrives as a burst of concurrent 401s, and
 * each would otherwise trigger its own logout and navigation. Never reset, since
 * the handler navigates away. The aggregator's client has the same guard
 * (`apps/web/src/services/http.ts`'s `redirecting` flag).
 */

type Handler = () => void;

const handlers = new Set<Handler>();
let fired = false;

/** Subscribes to the session-expired signal; returns an unsubscribe function. */
export function onSessionExpired(handler: Handler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Announces that the session is unrecoverable. Idempotent for the page
 * lifetime, so any number of concurrent failed requests may call it.
 */
export function emitSessionExpired(): void {
  if (fired) return;
  fired = true;
  for (const handler of handlers) handler();
}

/** Test-only: undo the fire-once latch between cases. */
export function resetSessionExpiredForTests(): void {
  fired = false;
  handlers.clear();
}
