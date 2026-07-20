/**
 * Row helpers — turn raw Drizzle rows (where JSON columns come back as
 * stringified text from SQLite) into shapes a Zod schema can validate.
 */

export function parseRow<T extends { metadata: unknown }>(row: T): T {
  return {
    ...row,
    metadata:
      typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
  };
}
