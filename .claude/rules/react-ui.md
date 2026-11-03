---
paths:
  - 'apps/ui/src/**/*.tsx'
  - 'apps/ui/src/hooks/**'
---

# Rule: React UI

`apps/ui` is React 19 on Vite — not Next.js. Read `apps/ui/CLAUDE.md` for the repo-specific runtime-env, theming and data-fetching patterns; this rule is the React baseline underneath them.

## Components

- Small and single-purpose. A component that fetches, filters, sorts and renders is three components.
- Props get a typed interface. No inline `any`, no untyped spread.
- List items need a stable, unique `key` — a real id such as `item_id`. An array index is only safe when the list never reorders, never has items inserted, and is never filtered.

## State and props

- Never mutate state or props. Build a new value.
- Use the functional setter when the next value depends on the previous one: `setCount(prev => prev + 1)`. Updates batch, and the direct form reads a stale value.
- Derive during render instead of mirroring into state. A value computed from props is always correct; a copy in state goes stale.
- Lift state to the nearest common parent when siblings need it.
- Avoid deep prop drilling. Use an existing context or a TanStack Query cache read.

```tsx
// ✅ derived
const visible = items.filter(i => i.lifecycle_status === "live");

// ❌ duplicated in state, needs an effect to stay in sync
const [visible, setVisible] = useState(items);
useEffect(() => setVisible(items.filter(i => i.lifecycle_status === "live")), [items]);
```

## Hooks and effects

- Rules of hooks: top level of a component or another hook only. Never in a condition, loop or callback.
- Keep effects minimal. Most things written as an effect are an event handler or a derived value. An effect is for synchronising with something outside React.
- Return a cleanup function from any effect that subscribes, opens a socket, or sets a timer.
- Do not add `useMemo` or `useCallback` by default. Add one when a measurement shows a cost, or when the value must stay referentially stable for another hook.
- **Do not hand-roll fetching in `useEffect`.** Use TanStack Query, so caching, retries and invalidation stay in one place.

## Validation and secrets

- The UI is not a control. Every rule the UI enforces — visibility, masking, eligibility, who may act — must also be enforced by the API. Treat a UI check as presentation only.
- Only `VITE_*` variables reach the browser bundle, so never put a secret behind that prefix.
