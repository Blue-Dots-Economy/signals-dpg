import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs, { existsSync, renameSync } from 'node:fs';
import path from 'path';

/**
 * Reads designer brand.json files from `examples/schemas/<network>/brand.json`
 * and injects per-network CSS custom properties as a `<style data-brand-themes>`
 * block inside index.html's <head>. Runs at build AND in dev (via Vite's
 * transformIndexHtml hook). No codegen output committed; brand.json is the
 * sole source of truth.
 *
 * Networks without a brand.json keep whatever the static `:root[data-network=…]`
 * blocks in index.css define — so the existing hardcoded fallbacks still apply.
 *
 * Optional `theme` override block on brand.json wins over the derived values.
 */
function brandThemePlugin(): Plugin {
  const schemasDir = path.resolve(__dirname, '..', '..', 'examples', 'schemas');

  // ─── colour helpers ──────────────────────────────────────────────────────
  const hexToRgb = (hex: string) => {
    const m = hex.replace('#', '').match(/^([0-9a-f]{6}|[0-9a-f]{3})$/i);
    if (!m) return null;
    let raw = m[1];
    if (raw.length === 3) raw = raw.split('').map((c) => c + c).join('');
    const n = parseInt(raw, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };
  const rgbToHsl = ({ r, g, b }: { r: number; g: number; b: number }) => {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break;
        case g: h = ((b - r) / d + 2) * 60; break;
        default: h = ((r - g) / d + 4) * 60;
      }
    }
    return { h, s, l };
  };
  const hslToHex = ({ h, s, l }: { h: number; s: number; l: number }) => {
    s = Math.max(0, Math.min(1, s));
    l = Math.max(0, Math.min(1, l));
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let rp = 0, gp = 0, bp = 0;
    if (h < 60)       [rp, gp, bp] = [c, x, 0];
    else if (h < 120) [rp, gp, bp] = [x, c, 0];
    else if (h < 180) [rp, gp, bp] = [0, c, x];
    else if (h < 240) [rp, gp, bp] = [0, x, c];
    else if (h < 300) [rp, gp, bp] = [x, 0, c];
    else              [rp, gp, bp] = [c, 0, x];
    const toHex = (v: number) =>
      Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${toHex(rp)}${toHex(gp)}${toHex(bp)}`;
  };
  const adjustL = (hex: string, l: number) => {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    return hslToHex({ ...rgbToHsl(rgb), l });
  };
  const isDark = (hex: string) => {
    const rgb = hexToRgb(hex);
    if (!rgb) return false;
    return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255 < 0.55;
  };

  type Swatch = { name?: string; hex: string };
  const NEUTRALS = new Set(['charcoal', 'off white', 'white', 'black']);
  const findShade = (swatches: Swatch[], colour: string, suffix: string) =>
    swatches.find(
      (s) => (s.name ?? '').toLowerCase() === `${colour} ${suffix}`.toLowerCase(),
    );

  // Quote font-family names that contain spaces / punctuation so the CSS
  // declaration stays valid (e.g. `"Open Sans"` not `Open Sans`).
  const cssFontFamily = (primary: string | undefined) => {
    const base = (primary ?? '').trim();
    if (!base) return '';
    const quoted = /[\s,]/.test(base) && !base.startsWith('"') ? `"${base}"` : base;
    return `${quoted}, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  };

  const deriveTheme = (brand: any, networkId: string) => {
    const fontFamily = cssFontFamily(brand?.typography?.primaryFont);
    if (brand?.theme && typeof brand.theme === 'object') {
      return { ...brand.theme, fontFamily: brand.theme.fontFamily ?? fontFamily };
    }
    const colours = brand?.colours ?? {};
    const primarySw: Swatch[] = Array.isArray(colours.primary) ? colours.primary : [];
    const accentSw: Swatch[] = Array.isArray(colours.accent) ? colours.accent : [];
    const colour = (networkId.split('_')[0] ?? '').toLowerCase();

    const pickShade = (suffixes: string[], fallback: string) => {
      for (const sfx of suffixes) {
        const hit = findShade(primarySw, colour, sfx);
        if (hit) return hit.hex;
      }
      return fallback;
    };
    const primary = pickShade(
      ['500', '600', '400'],
      primarySw.find((s) => !NEUTRALS.has((s.name ?? '').toLowerCase()))?.hex ??
        primarySw[0]?.hex ?? '#000000',
    );
    const heroFrom = pickShade(['900', '800', '700'], adjustL(primary, 0.12));
    const heroToShade = ['700', '600']
      .map((s) => findShade(primarySw, colour, s))
      .find((s) => s && s.hex.toLowerCase() !== heroFrom.toLowerCase());
    const heroFromHsl = rgbToHsl(hexToRgb(heroFrom)!);
    const heroTo = heroToShade
      ? heroToShade.hex
      : hslToHex({ ...heroFromHsl, l: Math.min(0.32, heroFromHsl.l + 0.12) });
    const heroHighlight = pickShade(['300', '400', '200', '100'], adjustL(primary, 0.78));

    const pale = accentSw.find((s) =>
      (s.name ?? '').toLowerCase().startsWith('pale'),
    );
    const accent = pale?.hex ?? accentSw[0]?.hex ?? '#f4f4f4';
    const darkName = (s: Swatch) =>
      ['ink', 'slate', 'charcoal'].includes((s.name ?? '').toLowerCase());
    const accentForeground =
      accentSw.find(darkName)?.hex ?? primarySw.find(darkName)?.hex ?? '#1e2a38';
    const primaryForeground = isDark(primary) ? '#ffffff' : '#1e2a38';

    return {
      primary,
      primaryForeground,
      accent,
      accentForeground,
      heroFrom,
      heroTo,
      heroHighlight,
      cta: primary,
      ctaForeground: primaryForeground,
      fontFamily,
    };
  };

  const tokensFromTheme = (t: Record<string, string>) => ({
    '--primary': t.primary,
    '--primary-foreground': t.primaryForeground,
    '--secondary': t.accent,
    '--secondary-foreground': t.accentForeground,
    '--accent': t.accent,
    '--accent-foreground': t.accentForeground,
    '--ring': t.primary,
    '--sidebar-primary': t.primary,
    '--sidebar-primary-foreground': t.primaryForeground,
    '--sidebar-accent': t.accent,
    '--sidebar-accent-foreground': t.accentForeground,
    '--sidebar-ring': t.primary,
    '--brand-hero-from': t.heroFrom,
    '--brand-hero-to': t.heroTo,
    '--brand-hero-highlight': t.heroHighlight,
    '--brand-hero-glow': t.heroHighlight,
    '--brand-stat-accent': t.heroHighlight,
    '--brand-cta': t.cta,
    '--brand-cta-foreground': t.ctaForeground,
    '--font-sans': t.fontFamily,
  });

  type BrandMeta = {
    faviconType?: 'png' | 'svg';
    logoShape?: 'square' | 'wordmark';
    copy?: Record<string, string>;
  };

  const extractMeta = (brandJson: any): BrandMeta => {
    const meta: BrandMeta = {};
    if (brandJson?.faviconType === 'png' || brandJson?.faviconType === 'svg') {
      meta.faviconType = brandJson.faviconType;
    }
    if (brandJson?.logoShape === 'square' || brandJson?.logoShape === 'wordmark') {
      meta.logoShape = brandJson.logoShape;
    }
    if (brandJson?.copy && typeof brandJson.copy === 'object' && !Array.isArray(brandJson.copy)) {
      meta.copy = brandJson.copy as Record<string, string>;
    }
    return meta;
  };

  // Derive CSS token lines from a brand.json for base networks (full synthesis
  // via colours: or theme: is both allowed here — networks define the baseline).
  const tokenLinesFromNetwork = (brandJson: any, networkId: string): string => {
    const tokens = tokensFromTheme(deriveTheme(brandJson, networkId));
    return Object.entries(tokens)
      .filter(([, v]) => typeof v === 'string' && v.length > 0)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join('\n');
  };

  // Derive CSS token lines for brand subfolders — strictly override-only.
  // Brand blocks express token deltas via the explicit `theme:` map; we do NOT
  // run the colours: synthesis branch here (that would emit a full token set and
  // defeat cascade inheritance from the network base). If a brand has no theme:
  // keys, emit nothing — it still inherits all tokens from the network base.
  const tokenLinesFromBrand = (brandJson: any): string => {
    if (!brandJson?.theme || typeof brandJson.theme !== 'object') return '';
    const fontFamily = cssFontFamily(brandJson?.typography?.primaryFont);
    const themeWithFont = { ...brandJson.theme, fontFamily: brandJson.theme.fontFamily ?? fontFamily };
    const tokens = tokensFromTheme(themeWithFont);
    return Object.entries(tokens)
      .filter(([, v]) => typeof v === 'string' && v.length > 0)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join('\n');
  };

  type RegistryEntry = BrandMeta & { brands: Record<string, BrandMeta> };

  // Scan all network and brand subdirectories once, returning CSS blocks and
  // the registry together so nothing is computed twice.
  const scanSchemas = (): {
    styleTag: string;
    registry: Record<string, RegistryEntry>;
  } => {
    const registry: Record<string, RegistryEntry> = {};
    if (!fs.existsSync(schemasDir)) return { styleTag: '', registry };
    const blocks: string[] = [];

    for (const name of fs.readdirSync(schemasDir)) {
      const networkDir = path.join(schemasDir, name);
      const stat = fs.statSync(networkDir, { throwIfNoEntry: false });
      if (!stat?.isDirectory()) continue;
      const brandPath = path.join(networkDir, 'brand.json');
      if (!fs.existsSync(brandPath)) continue;
      let brand: any;
      try {
        brand = JSON.parse(fs.readFileSync(brandPath, 'utf8'));
      } catch {
        continue;
      }

      // Emit base network block.
      const baseLines = tokenLinesFromNetwork(brand, name);
      blocks.push(`:root[data-network="${name}"] {\n${baseLines}\n}`);

      // Accumulate base network registry entry.
      registry[name] = { ...extractMeta(brand), brands: {} };

      // Scan subdirectories for per-brand overrides.
      for (const entry of fs.readdirSync(networkDir)) {
        const subDir = path.join(networkDir, entry);
        const subStat = fs.statSync(subDir, { throwIfNoEntry: false });
        if (!subStat?.isDirectory()) continue;
        const subBrandPath = path.join(subDir, 'brand.json');
        if (!fs.existsSync(subBrandPath)) continue;
        let subBrand: any;
        try {
          subBrand = JSON.parse(fs.readFileSync(subBrandPath, 'utf8'));
        } catch {
          continue;
        }

        // Override-only: emit only tokens present in this brand's theme: block.
        const brandLines = tokenLinesFromBrand(subBrand);
        if (brandLines) {
          blocks.push(`:root[data-network="${name}"][data-brand="${entry}"] {\n${brandLines}\n}`);
        }

        // Accumulate brand registry entry.
        registry[name].brands[entry] = extractMeta(subBrand);
      }
    }

    const styleTag =
      blocks.length === 0
        ? ''
        : `<style data-brand-themes>\n${blocks.join('\n\n')}\n</style>`;
    return { styleTag, registry };
  };

  // Eagerly scan once so that both `config()` and `transformIndexHtml` share
  // the same result without scanning the filesystem twice.
  const { styleTag: cachedStyleTag, registry: cachedRegistry } = scanSchemas();

  return {
    name: 'brand-theme-tokens',
    config() {
      return {
        define: {
          __BRAND_REGISTRY__: JSON.stringify(cachedRegistry),
        },
      };
    },
    transformIndexHtml(html) {
      if (!cachedStyleTag) return html;
      // Inject just before </head> so it overrides matching :root blocks in
      // index.css (same specificity, later source wins).
      return html.replace('</head>', `${cachedStyleTag}\n</head>`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isTourist = env.VITE_APP === 'tourist';
  const touristEntry = path.resolve(__dirname, 'index.tourist.html');
  const defaultNetworkTheme =
    env.VITE_DEFAULT_NETWORK_THEME ||
    (env.VITE_NETWORK_ID ? env.VITE_NETWORK_ID.split(',')[0].trim() : 'blue_dot');
  const defaultBrand = env.VITE_DEFAULT_BRAND?.trim() || 'standard';
  // Dev-server port is env-driven (VITE_UI_PORT), falling back to 5173.
  const uiPort = Number(env.VITE_UI_PORT) || 5173;

  return {
    plugins: [
      react(),
      tailwindcss(),
      brandThemePlugin(),
      ...(isTourist
        ? [
            {
              name: 'tourist-root-entry',
              configureServer(server) {
                server.middlewares.use((req, _res, next) => {
                  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
                  if (pathname === '/' || pathname === '/index.html') req.url = '/index.tourist.html';
                  next();
                });
              },
              // The build emits dist/index.tourist.html (Rollup keeps the source
              // filename); rename it to index.html so the tourist build is servable
              // at / by a static host. No-op in dev (closeBundle doesn't run there,
              // and the guard covers it anyway).
              closeBundle() {
                const built = path.resolve(__dirname, 'dist/tourist/index.tourist.html');
                const target = path.resolve(__dirname, 'dist/tourist/index.html');
                if (existsSync(built)) renameSync(built, target);
              },
            } as Plugin,
          ]
        : []),
    ],
    resolve: {
      // Mirror the tsconfig `paths` so Vite resolves the same aliases the
      // type-checker does. `@dpg/*` -> packages/*/src (workspace source);
      // listed before `@` since both are matched in order. Array form is
      // required for the regex `@dpg/*` mapping.
      alias: [
        // Lean, dependency-free subpath: the UI only needs the pure geo
        // helpers, NOT the @dpg/schemas barrel (which re-exports DB-bound
        // modules via @dpg/database → pg, breaking the browser build).
        // This specific entry must precede the generic @dpg/* mapping.
        {
          find: '@dpg/schemas/location_fields',
          replacement: path.resolve(
            __dirname,
            '../../packages/schemas/src/location_fields.ts',
          ),
        },
        {
          find: /^@dpg\/(.*)$/,
          replacement: path.resolve(__dirname, '../../packages/$1/src'),
        },
        { find: '@', replacement: path.resolve(__dirname, './src') },
      ],
    },
    define: {
      __DEFAULT_NETWORK_THEME__: JSON.stringify(defaultNetworkTheme),
      __DEFAULT_BRAND__: JSON.stringify(defaultBrand),
    },
    build: isTourist
      ? { outDir: 'dist/tourist', rollupOptions: { input: touristEntry } }
      : undefined,
    server: {
      port: uiPort,
      // Fail loudly if the port is taken instead of silently falling back to
      // 5174 — the fallback port isn't in the API's CORS allow-list, so a
      // silent switch surfaces as confusing CORS/500 errors in the browser.
      strictPort: true,
    },
    preview: {
      port: uiPort,
      strictPort: true,
    },
  };
});
