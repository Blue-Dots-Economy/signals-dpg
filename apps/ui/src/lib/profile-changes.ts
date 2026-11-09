const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

function sameValue(a: unknown, b: unknown): boolean {
  if (isEmpty(a) && isEmpty(b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameValue(v, b[i]))
    );
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
    return [...keys].every((k) => sameValue(ra[k], rb[k]));
  }
  return a === b;
}

/**
 * True when saving `submitted` would change the stored profile. Only submitted
 * keys count: the API merges the body onto the stored state, so a key the form
 * leaves out is kept, not cleared.
 */
export function hasProfileChanges(
  submitted: Record<string, unknown>,
  initial: Record<string, unknown> | null,
): boolean {
  if (!initial) return true;
  return Object.keys(submitted).some((k) => !sameValue(submitted[k], initial[k]));
}
