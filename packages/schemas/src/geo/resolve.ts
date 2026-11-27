import z from 'zod';

/** Body for POST /api/v1/geo/resolve. */
export const GeoResolveBodySchema = z.object({
  address: z.string().trim().min(1).max(200),
});
export type GeoResolveBody = z.infer<typeof GeoResolveBodySchema>;

/** 200 response for POST /api/v1/geo/resolve. */
export const GeoResolveResponseSchema = z.object({
  label: z.string(),
  point: z.object({ lat: z.number(), lng: z.number() }),
  precision: z.enum(['postal_code', 'locality', 'city', 'district']),
});
export type GeoResolveResponse = z.infer<typeof GeoResolveResponseSchema>;
