import { z } from 'zod';

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Id of the last row from the previous page. */
  cursor: z.string().uuid().optional(),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

/**
 * Keyset (cursor) pagination rather than OFFSET: page N costs the same as page 1
 * and rows inserted mid-scan can't cause duplicates or skips.
 */
export function keyset({ limit, cursor }: PageQuery) {
  return {
    take: limit + 1, // one extra row tells us whether another page exists
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { id: 'asc' as const },
  };
}

export function toPage<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    page: {
      limit,
      hasMore,
      nextCursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
    },
  };
}
