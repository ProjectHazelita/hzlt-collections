import type { Entry } from '@hcl/contracts';
import { FileText, Link2, MoreHorizontal } from 'lucide-react';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { copyText } from '../app/clipboard';
import { UserAvatar } from './UserAvatar';
import './gallery-content.css';

export function AttributeBadges({
  entry,
  overlay = false,
  longImage = false,
  count,
}: {
  entry: Entry;
  overlay?: boolean;
  longImage?: boolean;
  count?: number;
}) {
  const any = entry.declarations.nsfw || entry.declarations.aiGenerated || longImage || count;
  if (!any) return null;
  return (
    <div className={overlay ? 'attribute-badges overlay' : 'attribute-badges'}>
      {entry.declarations.nsfw && <span>NSFW</span>}
      {entry.declarations.aiGenerated && <span>AI 生成</span>}
      {longImage && <span>长图</span>}
      {count && count > 1 ? <span>{count} 张图片</span> : null}
    </div>
  );
}

export function Author({ entry, detail = false }: { entry: Entry; detail?: boolean }) {
  return (
    <Link
      to={`/users/${encodeURIComponent(entry.author.username)}`}
      className={detail ? 'author author-detail' : 'author'}
    >
      <UserAvatar user={entry.author} />
      <span>{entry.author.displayName}</span>
    </Link>
  );
}

function CardMenu({ entry }: { entry: Entry }) {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const slot = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!slot.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <span className="card-menu-slot" ref={slot}>
      <button
        type="button"
        className="card-more"
        aria-label="条目操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontal size={20} />
      </button>
      {open && (
        <span className="card-menu" role="menu" aria-label={`条目 #${entry.id} 操作`}>
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void copyText(new URL(`/entries/${entry.id}`, window.location.origin).href).then(
                (success) => {
                  setCopied(success);
                  if (success) window.setTimeout(() => setCopied(false), 2000);
                },
              );
            }}
          >
            {copied ? '链接已复制' : '复制条目链接'}
          </button>
          {entry.canEdit && (
            <Link role="menuitem" to={`/entries/${entry.id}/edit`} onClick={() => setOpen(false)}>
              编辑条目
            </Link>
          )}
          <Link
            role="menuitem"
            to={`/entries/${entry.id}`}
            state={{ backgroundLocation: location }}
            onClick={() => setOpen(false)}
          >
            打开详情
          </Link>
        </span>
      )}
    </span>
  );
}

function AttachmentSummary({ entry }: { entry: Entry }) {
  if (!entry.files.length && !entry.links.length) return null;
  return (
    <div className="card-attachment-summary">
      {entry.files.length > 0 && (
        <span>
          <FileText size={14} />
          <span>{entry.files[0].name}</span>
          <small>文件 · {entry.files.length}</small>
        </span>
      )}
      {entry.links.length > 0 && (
        <span>
          <Link2 size={14} />
          <span>{entry.links[0].host}</span>
          <small>链接 · {entry.links.length}</small>
        </span>
      )}
    </div>
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
  const surface = useRef<HTMLDivElement>(null);
  const bodyWrap = useRef<HTMLDivElement>(null);
  const [truncated, setTruncated] = useState(false);
  const [fadeHeight, setFadeHeight] = useState(0);
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      onMeasure(entry.id, element.getBoundingClientRect().height),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [entry.id, onMeasure]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Recheck truncation when the card text changes.
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    let active = true;
    const check = () => {
      if (active) setTruncated(element.scrollHeight > element.clientHeight + 1);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    void document.fonts?.ready.then(check);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [entry.title, entry.body]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Recompute the visible band when the card text changes.
  useLayoutEffect(() => {
    const element = surface.current;
    const wrap = bodyWrap.current;
    if (!truncated || !element || !wrap) {
      setFadeHeight(0);
      return;
    }
    setFadeHeight(Math.max(0, element.clientHeight - wrap.offsetTop));
  }, [truncated, entry.title, entry.body]);
  const image = entry.images[0];
  const tall = image ? image.height / image.width > 2.5 : false;
  const title = entry.title;
  return (
    <article
      ref={card}
      className={entry.declarations.nsfw ? 'entry-card sensitive-card' : 'entry-card'}
    >
      <Link
        className="card-main"
        to={`/entries/${entry.id}`}
        state={{ backgroundLocation: location }}
        aria-label={title ?? (entry.body.slice(0, 60) || `查看条目 #${entry.id}`)}
      >
        {image ? (
          <>
            <div className={tall ? 'card-image long-image' : 'card-image'}>
              <img
                src={image.thumbnailUrl}
                alt={title ?? ''}
                width={image.width}
                height={image.height}
                loading="lazy"
              />
              <AttributeBadges entry={entry} overlay longImage={tall} count={entry.images.length} />
              <div className="card-overlay">
                <span className="card-overlay-title">
                  {title || entry.body.split('\n', 1)[0] || `条目 #${entry.id}`}
                </span>
              </div>
            </div>
            <AttachmentSummary entry={entry} />
          </>
        ) : entry.files.length || entry.links.length ? (
          <div className="text-card-content attachment-card">
            <div className="attachment-preview">
              <AttachmentSummary entry={entry} />
              {title && <h2>{title}</h2>}
              <p className="text-card-body">
                {entry.body || entry.files[0]?.name || entry.links[0]?.host || ''}
              </p>
            </div>
            <AttributeBadges entry={entry} />
          </div>
        ) : (
          <div className="text-card-content">
            <div
              className="text-card-surface"
              ref={surface}
              style={
                fadeHeight ? ({ '--visible-body': `${fadeHeight}px` } as CSSProperties) : undefined
              }
            >
              {title && <h2>{title}</h2>}
              <div className="text-card-body-wrap" ref={bodyWrap}>
                <p className={truncated && fadeHeight ? 'text-card-body fading' : 'text-card-body'}>
                  {entry.body}
                </p>
                {truncated && fadeHeight > 0 && (
                  <p className="text-card-body text-card-blur" aria-hidden="true">
                    {entry.body}
                  </p>
                )}
              </div>
            </div>
            <AttributeBadges entry={entry} />
          </div>
        )}
      </Link>
      <div className="card-metadata">
        <Author entry={entry} />
        <CardMenu entry={entry} />
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
    const first = entry.images[0];
    const estimated = first
      ? columnWidth * Math.min(first.height / first.width, 2.5) + 60
      : entry.files.length || entry.links.length
        ? 160
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
