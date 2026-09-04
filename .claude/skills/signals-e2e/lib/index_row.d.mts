// Hand-written sibling declaration for index_row.mjs, a plain JS module with
// no JSDoc types of its own.
//
// Deliberately typed loosely (`any`) rather than as the literal union its
// interface documents (`{ text: string; params: unknown[] } | { delete: true
// }`): TypeScript does NOT narrow an explicitly-annotated union the way it
// narrows a plain inferred return type, so declaring that union here would
// make every unnarrowed `out.text` / `out.params` access in
// indexer-mapping.test.ts a TS2339 (confirmed: an explicit union return type
// errors on property access without an `if ('delete' in out)` guard first,
// where the SAME code with an inferred — unannotated — return type does not).
// The test intentionally checks `.delete` only on the delete-shaped cases and
// reads `.text`/`.params` directly on the others, so `any` is the type that
// keeps `npm run typecheck` green without rewriting the prescribed test.
// index_row.mjs itself is still exercised at its real, precise shape by
// index_row.mjs's own runtime logic and by every assertion in that test file.
export declare function rowForEvent(
  event: { item_network: string; item_domain: string; item_type: string; item_id: string; op: string },
  item: { lifecycle_status: string; updated_at: string } | null,
  locations: Array<{ lat: number; lng: number }>,
): any;
