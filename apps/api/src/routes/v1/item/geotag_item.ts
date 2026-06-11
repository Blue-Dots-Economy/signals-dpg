import { parseLocationFields, buildLocationQueries } from '@dpg/schemas';

interface ResolveArgs {
  provided: Array<{ lat: number; lng: number; label?: string }> | undefined;
  itemState: Record<string, unknown>;
  itemSchema: Record<string, unknown>;
  geocode: (query: string) => Promise<{ lat: number; lng: number } | null>;
}

/**
 * Resolves an item's locations: the caller-supplied array when present, else one
 * geocoded coord per marked query (multiple → per city w/ label; single → one).
 * Best-effort — queries that fail to geocode are skipped.
 */
export async function resolveItemLocations(
  args: ResolveArgs
): Promise<Array<{ lat: number; lng: number; label?: string }>> {
  if (args.provided && args.provided.length > 0) return args.provided;
  const fields = parseLocationFields(args.itemSchema);
  const queries = buildLocationQueries(args.itemState, fields);
  const out: Array<{ lat: number; lng: number; label?: string }> = [];
  for (const { query, label } of queries) {
    const coord = await args.geocode(query);
    if (coord) out.push(label ? { ...coord, label } : coord);
  }
  return out;
}
