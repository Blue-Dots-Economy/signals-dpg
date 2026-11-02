const default_allowed_origins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:2742',
];

const from_env =
  process.env.ALLOWED_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];

// In production a non-empty ALLOWED_ORIGINS replaces the localhost defaults;
// elsewhere it is added to them.
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
