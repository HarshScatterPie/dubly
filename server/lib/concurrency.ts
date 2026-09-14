/**
 * Runs `task` over `items` with at most `limit` running at once, keeping results in the
 * order the items came in.
 *
 * Used where a batch of independent provider calls (one per target language) would take
 * far too long run strictly one after another, but firing all of them at once trips the
 * provider's per-project rate limit — which then costs more time than it saved.
 */
export async function mapWithConcurrency<In, Out>(
  items: In[],
  limit: number,
  task: (item: In, index: number) => Promise<Out>
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
