import { useState, useCallback, useMemo, useEffect } from 'react';
import type { Item } from '@/lib/item-api';
import {
  calculateMatchScore,
  itemToSnapshot,
  type MatchScoreResult,
} from '@/lib/match-score-api';
import {
  getCachedMatchScore,
  setCachedMatchScore,
  clearMatchScoreCache,
} from '@/utils/match-score-cache';

interface UseMatchScoreOptions {
  localItem: Item | null;
  networkItem: Item;
  skipCache?: boolean;
}

interface UseMatchScoreReturn {
  score: MatchScoreResult | null;
  isLoading: boolean;
  error: Error | null;
  cached: boolean;
  calculate: () => Promise<void>;
  recalculate: () => Promise<void>;
  clearCache: () => void;
}

// `/discover` items carry a relevance score already rescaled to 0-100 by
// `fetchDiscover`, so the badge shows it up front. It has no confidence,
// signals or reasoning (those come from `/v1/relevance`); `source: 'discover'`
// tells the badge to hide the confidence line. Native items have no score and
// keep the click-to-fetch flow.
function seedFromDiscoverScore(networkItem: Item): MatchScoreResult | null {
  if (networkItem.score == null) return null;
  return {
    provider: 'discover',
    score: networkItem.score,
    source: 'discover',
  };
}

export function useMatchScore({
  localItem,
  networkItem,
  skipCache = false,
}: UseMatchScoreOptions): UseMatchScoreReturn {
  const [score, setScore] = useState<MatchScoreResult | null>(() =>
    seedFromDiscoverScore(networkItem)
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [cached, setCached] = useState(false);

  const cacheKey = useMemo(
    () => ({
      localItemId: localItem?.item_id ?? '',
      networkItemId: networkItem.item_id,
    }),
    [localItem?.item_id, networkItem.item_id]
  );

  // A score belongs to one (local profile, destination) pair, so a profile
  // switch clears it back to the discover seed.
  useEffect(() => {
    setScore(seedFromDiscoverScore(networkItem));
    setError(null);
    setCached(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey.localItemId, cacheKey.networkItemId, networkItem.score]);

  const calculate = useCallback(async () => {
    if (!localItem) {
      setError(new Error('No local item selected'));
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      if (!skipCache) {
        const cachedResult = getCachedMatchScore(
          cacheKey.localItemId,
          cacheKey.networkItemId
        );
        if (cachedResult) {
          setScore(cachedResult.score);
          setCached(true);
          setIsLoading(false);
          return;
        }
      }

      const payload = {
        itemA: itemToSnapshot(localItem),
        itemB: itemToSnapshot(networkItem),
      };

      const result = await calculateMatchScore(payload);
      
      setCachedMatchScore(cacheKey.localItemId, cacheKey.networkItemId, result);
      
      setScore(result);
      setCached(false);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to calculate match score';
      setError(new Error(errorMessage));
      setScore(null);
    } finally {
      setIsLoading(false);
    }
  }, [localItem, networkItem, cacheKey, skipCache]);

  const recalculate = useCallback(async () => {
    clearMatchScoreCache(cacheKey.localItemId, cacheKey.networkItemId);
    setCached(false);
    await calculate();
  }, [cacheKey.localItemId, cacheKey.networkItemId, calculate]);

  const clearCache = useCallback(() => {
    clearMatchScoreCache(cacheKey.localItemId, cacheKey.networkItemId);
    setScore(null);
    setCached(false);
  }, [cacheKey.localItemId, cacheKey.networkItemId]);

  return {
    score,
    isLoading,
    error,
    cached,
    calculate,
    recalculate,
    clearCache,
  };
}
