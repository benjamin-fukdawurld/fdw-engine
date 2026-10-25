import { cn } from '@fdw/editor-ui';
import { useMemo, useState, type KeyboardEvent } from 'react';

/** An entry of a search: a template to add, a node to find. */
export interface SearchItem {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  /** Shown under the title, and searched. */
  readonly detail?: string;
  /** Other words it is found by. */
  readonly keywords?: readonly string[];
}

/**
 * How well an item matches a query: the words of the query each found in
 * its title (better), its category, its detail or its keywords; undefined
 * when one is not found.
 */
export function searchScore(
  item: SearchItem,
  query: string,
): number | undefined {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const title = item.title.toLowerCase();
  const rest = [item.category, item.detail, ...(item.keywords ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  let score = 0;
  for (const word of words) {
    const at = title.indexOf(word);
    if (at === 0) score += 3;
    else if (at > 0) score += 2;
    else if (rest.includes(word)) score += 1;
    else return undefined;
  }
  // The shorter titles first among equals.
  return score - title.length / 1000;
}

/** The items matching a query, the best first; at most `limit`. */
export function searchItems(
  items: readonly SearchItem[],
  query: string,
  limit = 60,
): SearchItem[] {
  return items
    .map((item) => ({ item, score: searchScore(item, query) }))
    .filter(
      (entry): entry is { item: SearchItem; score: number } =>
        entry.score !== undefined,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/**
 * A search over items, in a box at a point of the canvas: typed, chosen by
 * the arrows and Enter or by a click; Escape closes it.
 */
export function NodeSearch({
  items,
  at,
  placeholder,
  onPick,
  onClose,
}: {
  readonly items: readonly SearchItem[];
  /** In pixels of the canvas. */
  readonly at: { readonly x: number; readonly y: number };
  readonly placeholder: string;
  readonly onPick: (item: SearchItem) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const found = useMemo(() => searchItems(items, query), [items, query]);
  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, found.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = found[active];
      if (item) onPick(item);
    }
  };
  return (
    <div
      role="dialog"
      aria-label={placeholder}
      data-over-viewport
      className="absolute z-20 flex w-72 flex-col overflow-hidden rounded-md border bg-popover text-xs text-popover-foreground shadow-lg"
      style={{ left: at.x, top: at.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <input
        autoFocus
        aria-label={placeholder}
        placeholder={placeholder}
        className="border-b bg-transparent px-2 py-1.5 outline-none"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={keyDown}
        onBlur={onClose}
      />
      <ul role="listbox" className="max-h-72 overflow-auto py-1">
        {found.map((item, index) => (
          <li
            key={item.id}
            role="option"
            aria-selected={index === active}
            className={cn(
              'cursor-default px-2 py-1',
              index === active && 'bg-accent text-accent-foreground',
            )}
            onPointerEnter={() => setActive(index)}
            // Before the blur of the field closes the search.
            onPointerDown={(event) => {
              event.preventDefault();
              onPick(item);
            }}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate">{item.title}</span>
              {item.category && (
                <span className="shrink-0 text-muted-foreground">
                  {item.category}
                </span>
              )}
            </div>
            {item.detail && (
              <div className="truncate text-muted-foreground">
                {item.detail}
              </div>
            )}
          </li>
        ))}
        {found.length === 0 && (
          <li className="px-2 py-1 text-muted-foreground">Nothing found.</li>
        )}
      </ul>
    </div>
  );
}
