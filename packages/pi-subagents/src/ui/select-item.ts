/**
 * select-item.ts — Pick an item from a string-only Pi selector without losing identity.
 *
 * Pi's dialog API returns the selected label, not an index. Numbering each row
 * makes labels unique even when display text is truncated or duplicated, while
 * keeping each label paired with the item it represents.
 */

export interface SelectUI {
  select(title: string, options: string[]): Promise<string | undefined>;
}

export async function selectItem<T>(
  ui: SelectUI,
  title: string,
  items: readonly T[],
  format: (item: T, index: number) => string,
): Promise<T | undefined> {
  const width = String(items.length).length;
  const rows = items.map((item, index) => ({
    item,
    label: `${String(index + 1).padStart(width)}. ${format(item, index)}`,
  }));
  const choice = await ui.select(title, rows.map(row => row.label));
  if (!choice) return undefined;
  return rows.find(row => row.label === choice)?.item;
}
