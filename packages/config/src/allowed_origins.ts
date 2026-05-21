const default_allowed_origins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:2742',
];

const from_env =
  process.env.ALLOWED_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];

// In production, ALLOWED_ORIGINS strictly overrides the defaults — we don't
// want localhost bleed into a deployed instance. In any other environment
// (dev, test) the env value augments the defaults so local UIs on 3000 /
// 5173 keep working even when ALLOWED_ORIGINS is set for some other purpose.
const is_production = process.env.NODE_ENV === 'production';

export const allowed_origins =
  is_production && from_env.length > 0
    ? from_env
    : Array.from(new Set([...default_allowed_origins, ...from_env]));

export function mergeAllowedOrigins(...originGroups: Array<string[]>) {
  return originGroups
    .flat()
    .filter(Boolean)
    .filter((origin, index, list) => list.indexOf(origin) === index);
}
