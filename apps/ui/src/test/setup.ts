import '@/i18n';
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { toast } from 'sonner';

// happy-dom 20 (bumped for the CVE-2025-61927 VM-escape RCE fix) no longer
// mirrors Storage onto the global scope the way real browsers and happy-dom 15
// did. The bare `localStorage` global then resolves to Node's experimental one,
// which is unavailable without `--localstorage-file`, so app modules that use
// the bare global (valid in a browser) blow up. Force-define browser-faithful
// Storage globals — Node's is a getter, so a plain assignment won't override it.
//
// The shim is a Proxy rather than a plain object because a real `Storage`
// exposes the STORED KEYS as its own enumerable properties and keeps the API
// (`getItem`, `length`, …) on the prototype. A plain object inverts that: the
// methods become the own keys, so `Object.keys(localStorage)` answers
// `['length','clear','getItem',…]` instead of `[]`, and `localStorage.foo`
// never reads back what `setItem('foo', …)` wrote. Both are things a browser
// test may legitimately assert — `lib/__tests__/bff-session.test.ts` asserts
// exactly the first, to name whatever leaked into storage rather than merely
// count it, and it failed against the plain object for that reason and no
// other.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  const api = {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  };
  // `api`'s own properties are all configurable, so reporting only the stored
  // keys from `ownKeys` satisfies the Proxy invariants.
  const isApiKey = (p: string | symbol): boolean => typeof p !== 'string' || p in api;
  return new Proxy(api, {
    get: (t, p, r) => (isApiKey(p) ? Reflect.get(t, p, r) : m.get(p as string)),
    set: (t, p, v, r) => {
      if (isApiKey(p)) return Reflect.set(t, p, v, r);
      m.set(p as string, String(v));
      return true;
    },
    has: (_t, p) => isApiKey(p) || m.has(p as string),
    deleteProperty: (t, p) => {
      if (isApiKey(p)) return Reflect.deleteProperty(t, p);
      m.delete(p as string);
      return true;
    },
    ownKeys: () => Array.from(m.keys()),
    getOwnPropertyDescriptor: (t, p) =>
      isApiKey(p)
        ? Reflect.getOwnPropertyDescriptor(t, p)
        : m.has(p as string)
          ? { value: m.get(p as string), writable: true, enumerable: true, configurable: true }
          : undefined,
  }) as Storage;
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  const fromWindow = (window as unknown as Record<string, Storage | undefined>)[name];
  Object.defineProperty(globalThis, name, {
    value: fromWindow ?? memoryStorage(),
    configurable: true,
    writable: true,
  });
}

// Tests run file-parallel across workers; on a loaded box (CI running api + ui
// + typecheck at once) a `findBy*`/`waitFor` can take longer than RTL's 1000ms
// default and spuriously time out. Give async utils headroom so contention
// slows tests instead of failing them. This is the real fix for the U18/auth
// suite flakiness, not a retry (which just hides it).
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  // sonner keeps its queue in a module-level singleton, outside React, so
  // `cleanup()` unmounting the `<Toaster />` doesn't touch it. Since 2.0.8 a
  // subscribing Toaster replays every still-active toast (so a toast fired
  // before it mounted isn't lost) — which means the next test's Toaster
  // inherits every toast an earlier test left undismissed, and unrelated
  // "this message is absent" assertions start failing.
  //
  // Dismiss by id rather than via the argument-less `toast.dismiss()`: only the
  // by-id branch marks the toast dismissed in the store on both 2.0.x lines.
  // The bare call just notifies subscribers, and `cleanup()` has already
  // unsubscribed the Toaster, so it would clear nothing.
  //
  // Suites that `vi.mock('sonner')` with a partial stub have neither function.
  if (typeof toast?.getToasts === 'function' && typeof toast.dismiss === 'function') {
    for (const active of toast.getToasts()) toast.dismiss(active.id);
  }
});
