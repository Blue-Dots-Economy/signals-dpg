import { getMatchScoreClient } from '@/utils/match_score_client';
import type { MatchScoreItem } from '@dpg/match_score';
import type { FastifyBaseLogger } from 'fastify';

export interface ItemSnapshotLike {
  item_network: string;
  item_domain: string;
  item_type: string;
  item_id: string;
  item_instance_url: string;
  item_schema_url: string;
  item_state: Record<string, unknown>;
  item_locations?: Array<{ lat: number; lng: number }> | null;
}

function toMatchScoreItem(s: ItemSnapshotLike): MatchScoreItem {
  const primary = s.item_locations?.[0] ?? null;
  return {
    item_network: s.item_network,
    item_domain: s.item_domain,
    item_type: s.item_type,
    item_id: s.item_id,
    item_instance_url: s.item_instance_url,
    item_schema_url: s.item_schema_url,
    item_state: s.item_state ?? {},
    item_latitude: primary ? primary.lat : null,
    item_longitude: primary ? primary.lng : null,
  };
}

/**
 * Computes the item-to-item relevance score for an action at create time.
 * Returns the numeric score, or null when a snapshot is missing (e.g.
 * cross-instance source) or the relevance service errors — never throws.
 */
export async function computeActionMatchScore(
  source: ItemSnapshotLike | null,
  target: ItemSnapshotLike | null,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<number | null> {
  if (!source || !target) return null;
  try {
    const client = getMatchScoreClient();
    if (!client) return null;
    const result = await client.calculate({
      itemA: toMatchScoreItem(source),
      itemB: toMatchScoreItem(target),
    });
    return typeof result.score === 'number' ? result.score : null;
  } catch (err) {
    log.warn({ err }, 'action match-score compute failed — storing null');
    return null;
  }
}
