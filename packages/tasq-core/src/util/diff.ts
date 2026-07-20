/**
 * Shallow record diff used by all updateX services to compute the
 * `before` / `after` payload of an "updated" event.
 *
 * Two values are considered equal if `JSON.stringify` is equal — fine
 * for our needs: scalars compare structurally, arrays/objects compare
 * by content, and the dataset is small (single record, one mutation).
 */
export function diffRecords<T extends Record<string, unknown>>(
  before: T,
  after: T,
): { before: Partial<T>; after: Partial<T> } {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  const keys = new Set<keyof T>([
    ...(Object.keys(before) as (keyof T)[]),
    ...(Object.keys(after) as (keyof T)[]),
  ]);
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a };
}
