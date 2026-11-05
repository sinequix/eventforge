// Pure request validation, kept free of `cloudflare:workers` so it is unit-testable in Node.
export const COLLECTIONS = [
  "events",
  "workflows",
  "actions",
  "runs",
  "forges",
  "audit",
  "memory",
] as const;
export type Collection = (typeof COLLECTIONS)[number];
export type Change = { collection: Collection; id: string; body: unknown };
export type StoredRecord = { collection: Collection; id: string; seq: number; body: unknown };

export const WORKSPACE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
export const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_CHANGES = 500;
export const MAX_RECORD_BYTES = 1_900_000; // SQLite-backed DO rows are limited to 2 MB.
export const DEFAULT_PAGE = 500;
export const MAX_PAGE = 1_000;

export function parseChanges(value: unknown): Change[] | string {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { changes?: unknown }).changes)
  )
    return 'Body must be {"changes": [...]}.';
  const changes = (value as { changes: unknown[] }).changes;
  if (changes.length > MAX_CHANGES) return `At most ${MAX_CHANGES} changes per request.`;
  const parsed: Change[] = [];
  for (const item of changes) {
    if (!item || typeof item !== "object") return "Each change must be an object.";
    const { collection, id, body } = item as Record<string, unknown>;
    if (!COLLECTIONS.includes(collection as Collection)) return "Unknown collection.";
    if (typeof id !== "string" || !ID_PATTERN.test(id)) return "Invalid record id.";
    if (!body || typeof body !== "object" || Array.isArray(body))
      return "Record body must be an object.";
    if ((body as { id?: unknown }).id !== id) return "Record body id must match the change id.";
    parsed.push({ collection: collection as Collection, id, body });
  }
  return parsed;
}
