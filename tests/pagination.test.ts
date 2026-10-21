import { describe, expect, it } from 'vitest';
import { keyset, pageQuerySchema, toPage } from '../src/http/pagination.js';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${i}` }));

describe('cursor pagination', () => {
  it('defaults to 20 per page and coerces string limits', () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(pageQuerySchema.parse({ limit: '5' }).limit).toBe(5);
  });

  it('caps the page size so a client cannot ask for the whole table', () => {
    expect(() => pageQuerySchema.parse({ limit: 1000 })).toThrow();
  });

  it('fetches one extra row to detect a further page', () => {
    expect(keyset({ limit: 20 }).take).toBe(21);
  });

  it('skips the cursor row itself so pages do not overlap', () => {
    const q = keyset({ limit: 10, cursor: '11111111-1111-1111-1111-111111111111' });
    expect(q.skip).toBe(1);
    expect(q.cursor).toEqual({ id: '11111111-1111-1111-1111-111111111111' });
  });

  it('trims the probe row and returns the next cursor', () => {
    const page = toPage(rows(21), 20);
    expect(page.data).toHaveLength(20);
    expect(page.page.hasMore).toBe(true);
    expect(page.page.nextCursor).toBe('id-19');
  });

  it('reports the last page without a cursor', () => {
    const page = toPage(rows(7), 20);
    expect(page.data).toHaveLength(7);
    expect(page.page.hasMore).toBe(false);
    expect(page.page.nextCursor).toBeNull();
  });

  it('handles an empty result set', () => {
    const page = toPage([], 20);
    expect(page.data).toEqual([]);
    expect(page.page.nextCursor).toBeNull();
  });
});
