import { parseLocationFields, buildGeoQuery } from '@dpg/schemas';

interface ResolveArgs {
  lat: number | null;
  lng: number | null;
  itemState: Record<string, unknown>;
  itemSchema: Record<string, unknown>;
  resolve: (query: string) => Promise<{ lat: number; lng: number } | null>;
}

/**
 * Returns coordinates for an item: the caller-supplied pair when present,
 * otherwise the geocode of the marked composite query. Best-effort — returns
 * `{ lat: null, lng: null }` when there is nothing to geocode or it fails.
 */
export async function resolveItemCoordinates(
  args: ResolveArgs
): Promise<{ lat: number | null; lng: number | null }> {
  if (args.lat !== null && args.lng !== null) {
    return { lat: args.lat, lng: args.lng };
  }
  const fields = parseLocationFields(args.itemSchema);
  const query = buildGeoQuery(args.itemState, fields);
  if (!query) return { lat: null, lng: null };
  const coords = await args.resolve(query);
  return coords ?? { lat: null, lng: null };
}
