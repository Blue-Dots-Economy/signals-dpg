import type { MatchScoreResult } from '@/lib/match-score-api';

/**
 * The version prefix marks the score scale (v2 = 0-100). Bump it whenever the
 * stored scale changes: a stored payload does not record its scale, so an old
 * entry read with the new formatter would print a wrong percentage silently.
 */
const CACHE_KEY_PREFIX = 'dpg:matchScore:v2';
const LEGACY_CACHE_KEY_PREFIXES = ['dpg:matchScore:v1'];
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CachedMatchScore {
  score: MatchScoreResult;
  timestamp: number;
  localItemId: string;
  networkItemId: string;
}

export function generateCacheKey(localItemId: string, networkItemId: string): string {
  return `${CACHE_KEY_PREFIX}:${localItemId}:${networkItemId}`;
}

export function getCachedMatchScore(
  localItemId: string,
  networkItemId: string
): CachedMatchScore | null {
  try {
    const cacheKey = generateCacheKey(localItemId, networkItemId);
    const cached = localStorage.getItem(cacheKey);
    
    if (!cached) return null;
    
    const parsed: CachedMatchScore = JSON.parse(cached);
    const age = Date.now() - parsed.timestamp;
    
    if (age > DEFAULT_CACHE_TTL_MS) {
      localStorage.removeItem(cacheKey);
      return null;
    }
    
    return parsed;
  } catch {
    return null;
  }
}

export function setCachedMatchScore(
  localItemId: string,
  networkItemId: string,
  score: MatchScoreResult
): void {
  try {
    const cacheKey = generateCacheKey(localItemId, networkItemId);
    const cached: CachedMatchScore = {
      score,
      timestamp: Date.now(),
      localItemId,
      networkItemId,
    };
    localStorage.setItem(cacheKey, JSON.stringify(cached));
  } catch {
    // localStorage full or unavailable.
  }
}

export function clearMatchScoreCache(
  localItemId?: string,
  networkItemId?: string
): void {
  try {
    if (localItemId && networkItemId) {
      const cacheKey = generateCacheKey(localItemId, networkItemId);
      localStorage.removeItem(cacheKey);
    } else if (localItemId) {
      const prefix = `${CACHE_KEY_PREFIX}:${localItemId}:`;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix)) {
          localStorage.removeItem(key);
        }
      }
    } else {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(CACHE_KEY_PREFIX)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((key) => localStorage.removeItem(key));
    }
  } catch {
    // localStorage unavailable.
  }
}

/**
 * Removes cached scores under legacy key prefixes. The 24-hour TTL is enforced
 * only on read, and nothing reads old prefixes, so without this they would stay
 * in localStorage and use quota. Called once at startup; idempotent.
 */
export function sweepLegacyMatchScoreCache(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && LEGACY_CACHE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        doomed.push(key);
      }
    }
    doomed.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Storage unavailable (private mode, quota) — nothing to clean up.
  }
}

/**
 * Scores are 0-100 on the wire and in the cache. There are no quality bands:
 * BGE-M3 profile-to-profile similarities cluster in a narrow range, so fixed
 * thresholds would read as near-constant.
 */
export function formatScorePercentage(score: number): string {
  return `${Math.round(score)}%`;
}
