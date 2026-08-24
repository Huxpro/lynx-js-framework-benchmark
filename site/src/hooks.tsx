import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** Tracks a visualization container instead of assuming its width at mount.
 * Plot still receives a concrete pixel width, while page and card resizing stay
 * responsive without scaling SVG text or strokes. */
export function useElementWidth<T extends HTMLElement>(ref: RefObject<T | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let frame = 0;
    const update = () => {
      const next = Math.round(node.getBoundingClientRect().width);
      setWidth((current) => current === next ? current : next);
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    });
    observer.observe(node);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ref]);
  return width;
}

/** Keeps responsive disclosure behavior aligned with the same content-driven
 * breakpoint used by the stylesheet. */
export function useMediaQuery(query: string): boolean {
  const read = () => typeof matchMedia === 'function' && matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

export function useTheme(): ['light' | 'dark', () => void] {
  const get = (): 'light' | 'dark' => {
    const stamped = document.documentElement.dataset.theme;
    if (stamped === 'dark' || stamped === 'light') return stamped;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };
  const [theme, setTheme] = useState<'light' | 'dark'>(get);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(get());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const toggle = useCallback(() => {
    const next = get() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    setTheme(next);
  }, []);
  return [theme, toggle];
}

export type HeatPalette = 'standard' | 'colorblind';

/** Persists the heatmap palette independently from light/dark appearance. */
export function useHeatPalette(): [HeatPalette, () => void] {
  const get = (): HeatPalette => document.documentElement.dataset.heatPalette === 'colorblind'
    ? 'colorblind'
    : 'standard';
  const [palette, setPalette] = useState<HeatPalette>(get);
  const toggle = useCallback(() => {
    const next: HeatPalette = get() === 'colorblind' ? 'standard' : 'colorblind';
    if (next === 'colorblind') {
      document.documentElement.dataset.heatPalette = next;
      localStorage.setItem('heat-palette', next);
    } else {
      delete document.documentElement.dataset.heatPalette;
      localStorage.removeItem('heat-palette');
    }
    setPalette(next);
  }, []);
  return [palette, toggle];
}

export interface TipContent {
  head: string;
  lines: string[];
}

/** Imperative tooltip: content via state (set on enter), position via ref on
 * mousemove so hovering never re-renders the chart under it. */
export function useTooltip() {
  const [tip, setTip] = useState<TipContent | null>(null);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const place = useCallback((e: { clientX: number; clientY: number }) => {
    const node = nodeRef.current;
    if (!node) return;
    const pad = 14;
    const { innerWidth, innerHeight } = window;
    const rect = node.getBoundingClientRect();
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + rect.width > innerWidth - 8) x = e.clientX - rect.width - pad;
    if (y + rect.height > innerHeight - 8) y = e.clientY - rect.height - pad;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
  }, []);
  const onMove = useCallback((e: React.MouseEvent) => place(e), [place]);
  const tipNode = tip ? (
    <div className="viz-tip" ref={(n) => { nodeRef.current = n; }}>
      <div className="tip-head">{tip.head}</div>
      {tip.lines.map((l, i) => <div key={i} className="tip-sub">{l}</div>)}
    </div>
  ) : null;
  return { tip, setTip, onMove, place, tipNode };
}
