// Pure mapping from an item event to the item_search write, kept separate from
// the Redis consumer so it is directly testable.
//
// item_search's DDL authority is apps/api/db/postgres/schema.sql:108. embedding
// is vector(1024) and nullable — the stub indexes no embedding, which is
// correct: relevance ranking is the search stub's business, and a NULL
// embedding still satisfies every lifecycle/visibility assertion.
//
// source_updated_at must be the indexed row's items.updated_at, not now():
// the real sweep compares VERSIONS rather than clocks (signals-search#122).
export function rowForEvent(event, item, locations) {
  if (event.op === 'delete' || !item) {
    // An upsert for a vanished item is also a delete — indexing a row we cannot
    // read would leave the index claiming an item that no longer exists.
    return { delete: true };
  }
  const geo = locations.length
    ? `SRID=4326;MULTIPOINT(${locations.map((l) => `${l.lng} ${l.lat}`).join(',')})`
    : null;
  return {
    text: `
      INSERT INTO item_search
        (item_network, item_domain, item_type, item_id, geo, lifecycle_status, source_updated_at, indexed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7, now())
      ON CONFLICT (item_network, item_domain, item_type, item_id) DO UPDATE
        SET geo = EXCLUDED.geo,
            lifecycle_status = EXCLUDED.lifecycle_status,
            source_updated_at = EXCLUDED.source_updated_at,
            indexed_at = now()
    `,
    params: [
      event.item_network, event.item_domain, event.item_type, event.item_id,
      geo, item.lifecycle_status, item.updated_at,
    ],
  };
}
