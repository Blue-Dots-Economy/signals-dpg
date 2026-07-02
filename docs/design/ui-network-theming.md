# UI Network Theming

This document covers how the Signals-DPG web UI is themed per network, how to configure it, and how to add a new network theme.

---

## Quick start

**Default theme:** `blue_dot` (blue/navy — requires no configuration).

To change the theme for a deployment, set one environment variable in the root `.env`:

```env
VITE_DEFAULT_NETWORK_THEME=purple_dot
```

That's it. On the next `pnpm dev:ui` or build, the whole UI — buttons, focus rings, sidebar, hero gradient, constellation glow — ships in the configured network's colour.

---

## Available themes

| Network ID | Colour | Hero gradient | CTA |
|---|---|---|---|
| `blue_dot` **(default)** | Blue / navy | `#0b1530` → `#1a2554` | Violet `oklch(0.55 0.22 285)` |
| `purple_dot` | Purple / violet | `#1a0b30` → `#2d1354` | Purple `oklch(0.55 0.22 300)` |
| `yellow_dot` | Amber / gold | `#1e1300` → `#2e1f00` | Amber `oklch(0.68 0.18 80)` |
| `pink_dot` | Rose / magenta | `#1f0b14` → `#3d1528` | Rose `oklch(0.60 0.22 350)` |
| `green_dot` | Emerald / teal | `#071a0e` → `#0d2d18` | Green `oklch(0.55 0.18 155)` |

The network ID must match the `"id"` field in the corresponding `network.json` — the theme key and the network ID are identical by convention.

---

## Configuration options

### 1. Environment variable (recommended for deployments)

Set in the root `.env` (UI reads `VITE_*` from it via `pnpm dev:ui`/build) or as a shell/CI secret:

```env
# Active network theme. Allowed values: blue_dot | purple_dot | yellow_dot | pink_dot | green_dot
# Falls back to VITE_NETWORK_ID (first value) if unset, then to blue_dot.
VITE_DEFAULT_NETWORK_THEME=blue_dot
```

Vite reads this at build time and injects it as `__DEFAULT_NETWORK_THEME__` into the pre-React bootstrap script in `index.html`. The correct `<html data-network="…">` attribute is set before the first CSS paint — no flash of unstyled content on hard refresh.

### 2. Multiple networks via `VITE_NETWORK_ID`

If `VITE_DEFAULT_NETWORK_THEME` is not set but `VITE_NETWORK_ID` is configured, the first network ID in the comma-separated list is used as the default theme:

```env
# Theme defaults to yellow_dot (first in list)
VITE_NETWORK_ID=yellow_dot,blue_dot
```

### 3. URL query param `?network=` (runtime, no rebuild needed)

Appending `?network=purple_dot` to any URL switches the theme for that page load. Useful for:
- Testing a different network on the same running instance
- Deep linking to a specific network view

The sidebar network selector writes this param to the URL automatically when switching networks.

### 4. Theme resolution order (highest to lowest priority)

```
?network= query param
    ↓
VITE_DEFAULT_NETWORK_THEME (env var)
    ↓
VITE_NETWORK_ID first value (env var)
    ↓
'blue_dot' (hardcoded fallback)
```

If none of the above resolves to a known theme ID, `blue_dot` is used.

---

## What the theme controls

Every theme sets **17 CSS custom properties** that drive all shadcn UI primitives (buttons, inputs, focus rings, toggle groups, sidebar items) and the hero panel:

| Token | What it affects |
|---|---|
| `--primary` | Primary buttons, active sidebar items, badges |
| `--primary-foreground` | Text on primary-coloured surfaces |
| `--secondary` | Secondary buttons, toggle group backgrounds |
| `--secondary-foreground` | Text on secondary surfaces |
| `--accent` | Hover backgrounds (sidebar, dropdowns) |
| `--accent-foreground` | Text on accent surfaces |
| `--ring` | Keyboard focus rings on all interactive elements |
| `--sidebar-primary` | Active item background in the sidebar |
| `--sidebar-primary-foreground` | Text of active sidebar item |
| `--sidebar-accent` | Sidebar item hover background |
| `--sidebar-accent-foreground` | Sidebar item hover text |
| `--sidebar-ring` | Focus ring inside the sidebar |
| `--brand-hero-from` | Hero gradient start colour (top-left) |
| `--brand-hero-to` | Hero gradient end colour (bottom-right) |
| `--brand-hero-highlight` | Colour of the highlighted word in the tagline |
| `--brand-hero-glow` | Constellation dot/line/halo colour |
| `--brand-stat-accent` | Hero stat counter number colour |
| `--brand-cta` | Primary CTA button colour (may differ from `--primary`) |
| `--brand-cta-foreground` | Text on the CTA button |

> **Note on `--brand-cta` vs `--primary`:** Most themes set these to the same value. The `blue_dot` theme deliberately uses a violet CTA on a blue brand (matching the reference portal), so operators can keep distinct brand and action colours.

In addition to the colour tokens, each theme also carries per-network **copy**:
- `name` — display name (e.g. "Blue Dots")
- `tagline` — `{ lead, highlight, tail }` — used in the hero panel
- `subline` — one-paragraph description below the tagline
- `portalLabel` — shown under the wordmark (e.g. "Seeker & Provider Portal")
- `inviteLine` — footer attribution (e.g. "Invite-only · Blue Dots DPG")
- `stats` — four stat blocks shown at the bottom of the hero (`[{ value, label }]`)

---

## How theming works internally

### Two-layer, no-flash design

Naive approaches (setting CSS vars inside a React `useEffect`) cause a visible flash on hard refresh because the browser paints before JavaScript runs. This implementation avoids that with a two-layer approach:

**Layer 1 — pre-React bootstrap (zero flash)**

`apps/ui/index.html` contains a synchronous inline `<script>` that:
1. Reads `?network=` from the URL.
2. Falls back to `__DEFAULT_NETWORK_THEME__` (injected by Vite at build time from the env var).
3. Writes `document.documentElement.dataset.network = id` before any React code runs.

`apps/ui/src/index.css` has static `:root[data-network="…"]` CSS blocks for every known theme. The browser applies the matching block as part of its first style calculation — the themed colours are present on the very first paint.

**Layer 2 — runtime swap (when user changes network in sidebar)**

`apps/ui/src/theme/theme-provider.tsx` is a React context that:
1. Subscribes to `useSearchParams`.
2. When `?network=` changes, writes all 17 tokens as inline `style` properties on `<html>`. Inline styles have higher specificity than attribute-selector rules, so the swap is instantaneous.
3. Exposes the full `NetworkTheme` object (including copy strings) via `useNetworkTheme()`.

### Key files

| File | Role |
|---|---|
| `apps/ui/index.html` | Pre-React bootstrap script (Layer 1) |
| `apps/ui/vite.config.ts` | Injects `__DEFAULT_NETWORK_THEME__` via `define` |
| `apps/ui/src/index.css` | Static per-network CSS blocks + brand utility classes |
| `apps/ui/src/theme/network-themes.ts` | Theme map: 5 entries, all tokens + copy |
| `apps/ui/src/theme/theme-provider.tsx` | React context + runtime token applier (Layer 2) |
| `apps/ui/src/theme/form-layouts.ts` | Per-domain form section/two-column config |
| `apps/ui/src/components/layout/auth-shell.tsx` | Split-screen unauthenticated page wrapper |
| `apps/ui/src/components/layout/brand-hero.tsx` | Hero panel (gradient + constellation + tagline + stats) |
| `apps/ui/src/components/layout/portal-header.tsx` | Dot-mark logo + network name + portal label |
| `apps/ui/src/components/layout/auth-footer.tsx` | Invite line + Privacy/Terms + "Need help?" |
| `apps/ui/src/components/layout/network-constellation.tsx` | Inline SVG illustration, themed via CSS vars |
| `apps/ui/src/components/cards/role-card.tsx` | Styled domain-selector card (profile creation) |
| `apps/ui/src/components/empty-state.tsx` | Branded empty list state with sparse SVG dots |

---

## Adding a new network theme

1. **Add a theme entry** in `apps/ui/src/theme/network-themes.ts`:

   ```ts
   const red_dot: NetworkTheme = {
     name: 'Red Dot',
     tagline: {
       lead: 'Connecting',
       highlight: 'communities',
       tail: 'to emergency services and relief.',
     },
     subline: 'A unified network for disaster relief coordination.',
     portalLabel: 'Relief Portal',
     inviteLine: 'Invite-only · Red Dot DPG',
     stats: [
       { value: '500K+', label: 'Beneficiaries' },
       { value: '3K', label: 'Responders' },
       { value: '28', label: 'Aggregators' },
       { value: '61%', label: 'Response rate' },
     ],
     tokens: {
       '--primary': 'oklch(0.55 0.22 25)',           // red
       '--primary-foreground': 'oklch(0.985 0 0)',
       '--secondary': 'oklch(0.94 0.04 25)',
       '--secondary-foreground': 'oklch(0.20 0 0)',
       '--accent': 'oklch(0.94 0.04 25)',
       '--accent-foreground': 'oklch(0.20 0 0)',
       '--ring': 'oklch(0.65 0.15 25)',
       '--sidebar-primary': 'oklch(0.55 0.22 25)',
       '--sidebar-primary-foreground': 'oklch(0.985 0 0)',
       '--sidebar-accent': 'oklch(0.96 0.03 25)',
       '--sidebar-accent-foreground': 'oklch(0.25 0 0)',
       '--sidebar-ring': 'oklch(0.65 0.15 25)',
       '--brand-hero-from': '#2a0808',
       '--brand-hero-to': '#4a1010',
       '--brand-hero-highlight': '#ffaaaa',
       '--brand-hero-glow': '#ef4444',
       '--brand-stat-accent': '#ffaaaa',
       '--brand-cta': 'oklch(0.55 0.22 25)',
       '--brand-cta-foreground': '#ffffff',
     },
   };

   // Add to the map:
   export const networkThemes: Record<string, NetworkTheme> = {
     blue_dot,
     purple_dot,
     yellow_dot,
     pink_dot,
     green_dot,
     red_dot,   // ← new
   };
   ```

2. **Add the static CSS block** in `apps/ui/src/index.css` (copy any existing block and adjust values):

   ```css
   :root[data-network="red_dot"] {
     --primary: oklch(0.55 0.22 25);
     /* … same 17 tokens as the entry above … */
   }
   ```

3. **Set the env var** (or pass `?network=red_dot`) to activate it.

No other files need to change. The hero, constellation, sidebar, buttons, and focus rings all pick up the new values automatically.

---

## Form section layouts

Long profile-creation forms can declare section headers and two-column field groupings in `apps/ui/src/theme/form-layouts.ts`. Each entry is keyed by domain ID:

```ts
// Example: new domain 'relief_worker'
relief_worker: {
  sections: [
    { title: 'Personal Details', fields: ['name', 'phone', 'email', 'location'] },
    { title: 'Deployment Readiness', fields: ['availability', 'skills', 'languages'] },
  ],
  twoColumn: ['phone', 'email', 'availability', 'skills'],
},
```

Domains without an entry in `formLayouts` render in the default single-column RJSF layout — no breakage.

---

## Unauthenticated pages

All login, OTP verification, and profile-creation (role-select) pages use the `AuthShell` layout:

```
┌─────────────────────────────────────────────────────────┐
│  [Hero — gradient + constellation + tagline + stats]    │
│                           │  [PortalHeader]             │
│   (hidden on mobile,      │  [Form content]             │
│    96px band on mobile)   │  [AuthFooter]               │
└─────────────────────────────────────────────────────────┘
```

The hero panel automatically uses the active network's colours, tagline copy, and stat counters from `network-themes.ts`. No per-page configuration is needed.

---

## Known limitations (v1)

- **Dark mode:** The `.dark` CSS class exists in `index.css` but no toggle ships yet. Dark variants are not defined per network — each theme is light-only. A dark-mode toggle will require a second set of 17 tokens per theme.
- **Taglines are English-only.** Internationalisation of hero copy is not in scope for v1.
- **Stats are static.** Numbers in the hero (e.g. "2.4M+ Seekers") are hardcoded per theme, not fetched from the API.
- **`next-themes`** is installed but used solely by `sonner.tsx` for toast theming. It is not involved in network theming.
