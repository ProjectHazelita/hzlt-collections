import type { Entry } from '@hcl/contracts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { EntryIdentity } from './EntryIdentity';

export function AttributeBadges({ entry, overlay = false }: { entry: Entry; overlay?: boolean }) {
  return (
    <div className={overlay ? 'attribute-badges overlay' : 'attribute-badges'}>
      {entry.declarations.nsfw && <span>NSFW</span>}
      {entry.declarations.aiGenerated && <span>AI 生成</span>}
    </div>
  );
}

export function Author({ entry, detail = false }: { entry: Entry; detail?: boolean }) {
  return (
    <span className={detail ? 'author author-detail' : 'author'}>
      <span className="avatar">{Array.from(entry.author.username)[0]}</span>
      <span>{entry.author.username}</span>
    </span>
  );
}

function EntryCard({
  entry,
  onMeasure,
}: {
  entry: Entry;
  onMeasure: (id: string, height: number) => void;
}) {
  const location = useLocation();
  const card = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      onMeasure(entry.id, element.getBoundingClientRect().height),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [entry.id, onMeasure]);
  const asset = entry.asset;
  const tall = asset ? asset.height / asset.width > 3 : false;
  return (
    <article ref={card} className="entry-card">
      <Link
        className="card-main"
        to={`/entries/${entry.id}`}
        state={{ backgroundLocation: location }}
        aria-label={entry.title ?? (entry.body.slice(0, 60) || `查看条目 #${entry.id}`)}
      >
        {asset ? (
          <div className="card-image">
            <img
              src={asset.thumbnailUrl}
              alt={entry.title ?? ''}
              width={asset.width}
              height={asset.height}
              loading="lazy"
            />
            {tall && <span className="long-image-label">长图</span>}
            <AttributeBadges entry={entry} overlay />
            {(entry.title || entry.tags.length > 0) && (
              <div className="card-overlay">
                {entry.title && <span className="card-overlay-title">{entry.title}</span>}
                {entry.tags.length > 0 && (
                  <div className="card-tags">
                    {entry.tags.map((tag) => (
                      <span key={tag}># {tag}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="text-card-content">
            {entry.title && <h2>{entry.title}</h2>}
            <p>{entry.body}</p>
            {entry.body.length > 160 && <span className="read-more">阅读全文</span>}
            <AttributeBadges entry={entry} />
          </div>
        )}
      </Link>
      <div className="card-metadata">
        <Author entry={entry} />
        <EntryIdentity id={entry.id} variant="card" />
      </div>
    </article>
  );
}

export function MasonryFeed({ entries }: { entries: Entry[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  const [revision, setRevision] = useState(0);
  const measurements = useRef(new Map<string, number>());
  const measure = useRef((id: string, height: number) => {
    const rounded = Math.round(height);
    if (measurements.current.get(id) !== rounded) {
      measurements.current.set(id, rounded);
      setRevision((value) => value + 1);
    }
  }).current;
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    // Measure before the first paint so the feed never renders one wide column first.
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const count = mobile ? 2 : Math.min(5, Math.max(1, Math.floor((width + 12) / 252)));
  const columnWidth = (width - (count - 1) * 12) / count;
  const previous = useRef({
    width: 0,
    count: 0,
    revision: -1,
    ids: [] as string[],
    columns: [] as Entry[][],
    heights: [] as number[],
  });
  const state = previous.current;
  const appendOnly =
    state.width === width &&
    state.count === count &&
    state.revision === revision &&
    state.ids.every((id, index) => entries[index]?.id === id);
  const columns: Entry[][] = appendOnly
    ? state.columns.map((column) =>
        column.map((item) => entries.find((entry) => entry.id === item.id)!),
      )
    : Array.from({ length: count }, () => []);
  const heights = appendOnly ? [...state.heights] : Array<number>(count).fill(0);
  for (const entry of entries.slice(appendOnly ? state.ids.length : 0)) {
    const column = heights.indexOf(Math.min(...heights));
    columns[column]!.push(entry);
    const estimated = entry.asset
      ? columnWidth * Math.min(entry.asset.height / entry.asset.width, 2.5) + 60
      : Math.min(8, Math.ceil(entry.body.length / Math.max(8, columnWidth / 7))) * 22 + 88;
    heights[column]! += (measurements.current.get(entry.id) ?? estimated) + 16;
  }
  previous.current = {
    width,
    count,
    revision,
    ids: entries.map((entry) => entry.id),
    columns,
    heights,
  };
  return (
    <div ref={container} className="masonry-feed">
      {columns.map((column, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Columns are stable positional slots; entries inside use their own IDs.
        <div className="masonry-column" key={index}>
          {column.map((entry) => (
            <EntryCard key={entry.id} entry={entry} onMeasure={measure} />
          ))}
        </div>
      ))}
    </div>
  );
}
