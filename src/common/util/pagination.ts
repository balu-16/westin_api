/**
 * Shared pagination for list endpoints that return an envelope
 * `{ rows, total, page, pageSize }` with the per-row shape unchanged.
 */

export type PageParams = {
  page: number;
  pageSize: number;
  /** pageSize clamped to [1, 100]. */
  limit: number;
  offset: number;
};

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 50;

/** Defaults: page=1, pageSize=10; pageSize capped at 50; garbage -> defaults. */
export function pageParams(page?: number | string, pageSize?: number | string): PageParams {
  const p = Math.max(1, Math.floor(Number(page)) || 1);
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(pageSize)) || DEFAULT_PAGE_SIZE));
  return { page: p, pageSize: size, limit: size, offset: (p - 1) * size };
}

/**
 * Build the envelope from rows that carry a `count(*) over()` column named
 * `__total` (stripped from the returned rows).
 */
export function paginatedEnvelope<T extends Record<string, any>>(
  rows: (T & { __total?: string | number })[],
  pg: PageParams,
): { rows: T[]; total: number; page: number; pageSize: number } {
  const total = rows.length ? Number(rows[0].__total ?? rows.length) : 0;
  return {
    rows: rows.map((r) => {
      const { __total, ...rest } = r;
      return rest as T;
    }),
    total,
    page: pg.page,
    pageSize: pg.pageSize,
  };
}
