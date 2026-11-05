/** Bounded work, with results kept in input order and no new work after retirement. */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  isCurrent: () => boolean,
  visit: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (isCurrent()) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await visit(items[index]);
      }
    }),
  );
  return results;
}
