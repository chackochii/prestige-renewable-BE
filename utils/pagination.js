// Paging for list endpoints: ?page=&pageSize= in, and
//
//   { success: true, data: [...rows on this page], total, page, pageSize, ...extra }
//
// out, where `total` counts every row matching the filters (not just this
// page) and `extra` carries what the screen needs across the whole set — the
// counts behind its stat cards, say — so one request is enough.

/** Rows a page holds when the caller does not say (the screens ask for 12). */
export const DEFAULT_PAGE_SIZE = 12;

/** { page, pageSize, offset, limit } from a query string; page counts from 1, the size is held to 1…maxSize. */
export const pagingOf = (query = {}, { defaultSize = DEFAULT_PAGE_SIZE, maxSize = 100 } = {}) => {
    const pageSize = Math.min(Math.max(Math.trunc(Number(query.pageSize)) || defaultSize, 1), maxSize);
    const page = Math.max(Math.trunc(Number(query.page)) || 1, 1);
    return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
};

/** One page out of a list already held in memory. */
export const pageOf = (list, paging) => (Array.isArray(list) ? list.slice(paging.offset, paging.offset + paging.limit) : []);

/** Newest first by a date field (ties broken by id, newest first) — the order every paged list uses. */
export const newestFirst = (dateOf) => (a, b) => (new Date(dateOf(b) ?? 0) - new Date(dateOf(a) ?? 0)) || (Number(b.id ?? 0) - Number(a.id ?? 0));
