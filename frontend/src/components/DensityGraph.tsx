import { useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { Density } from "../types";
import { fmtSpan, fmtTime, niceStep, parseTime } from "../util";

const DENS_H = 130, PAD = { l: 4, r: 4, t: 10, b: 18 };
const X_STEPS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600].map((s) => s * 1000);
const r1 = (n: number) => Math.round(n * 10) / 10;

interface Props {
  density: Density | null;
  loading: boolean;
  tFrom: string;
  tTo: string;
  onJump: (ms: number) => void;              // plain click: page the table to that moment
  onRange: (fromMs: number, toMs: number) => void;  // drag or peak click: filter to a time range
}

interface Hover { at: number; count: number; peak: boolean }
interface Drag { clientX: number; ms: number; moved: boolean; peak: number | null }

/** Hot-spot graph: chats in the next window from each moment of the stream. */
export default function DensityGraph({ density: d, loading, tFrom, tTo, onJump, onRange }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<Hover | null>(null);
  const [brush, setBrush] = useState<[number, number] | null>(null);

  useLayoutEffect(() => {
    const el = svg.current!;
    const measure = () => setW(el.clientWidth || 600);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => setHover(null), [d]);  // a redraw clears the hover readout

  const { l, r, t, b } = PAD, pw = w - l - r, ph = DENS_H - t - b;
  const x = (ms: number) => l + Math.min(ms / (d?.span_ms || 1), 1) * pw;

  // Keep the tooltip centered on the guide line, inside the box.
  useLayoutEffect(() => {
    const tp = tip.current, bx = box.current, sv = svg.current;
    if (!hover || !tp || !bx || !sv) return;
    const svgLeft = sv.getBoundingClientRect().left - bx.getBoundingClientRect().left - bx.clientLeft;
    const left = svgLeft + x(hover.at) - tp.offsetWidth / 2;
    tp.style.left = Math.min(Math.max(left, 4), bx.clientWidth - tp.offsetWidth - 4) + "px";
  });

  function msAt(e: RPointerEvent) {
    const rect = svg.current!.getBoundingClientRect();
    const frac = (e.clientX - rect.left - l) / (rect.width - l - r);
    return Math.min(Math.max(frac, 0), 1) * d!.span_ms;
  }

  const peakOf = (e: RPointerEvent) => {
    const v = (e.target as Element).getAttribute("data-peak");
    return v == null ? null : Number(v);
  };

  function showHover(ms: number, peak: number | null) {
    if (!d) return;
    if (peak != null) {
      setHover({ at: d.peaks[peak].offset_ms, count: d.peaks[peak].count, peak: true });
    } else {
      const i = Math.min(Math.floor(ms / d.bucket_ms), d.nearby.length - 1);
      setHover({ at: i * d.bucket_ms, count: d.nearby[i], peak: false });
    }
  }

  const handlers = {
    onPointerDown(e: RPointerEvent<SVGSVGElement>) {
      if (!d || e.button !== 0) return;
      drag.current = { clientX: e.clientX, ms: msAt(e), moved: false, peak: peakOf(e) };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e: RPointerEvent<SVGSVGElement>) {
      if (!d) return;
      const ms = msAt(e), g = drag.current;
      if (g) {
        if (Math.abs(e.clientX - g.clientX) > 4) g.moved = true;
        if (g.moved) setBrush([Math.min(g.ms, ms), Math.max(g.ms, ms)]);
      }
      showHover(ms, g ? null : peakOf(e));
    },
    onPointerUp(e: RPointerEvent<SVGSVGElement>) {
      const g = drag.current;
      if (!g || !d) return;
      const ms = msAt(e);
      drag.current = null;
      setBrush(null);
      setHover(null);
      if (g.moved) {
        onRange(Math.min(g.ms, ms), Math.max(g.ms, ms));
      } else if (g.peak != null) {
        const p = d.peaks[g.peak];
        onRange(p.offset_ms, p.offset_ms + d.window_ms);
      } else {
        onJump(g.ms);
      }
    },
    onPointerCancel() {
      drag.current = null;
      setBrush(null);
    },
    onPointerLeave() {
      if (!drag.current) setHover(null);
    },
  };

  let body = null;
  if (d) {
    const top = Math.max(1, ...d.nearby) * 1.15;  // headroom above the tallest spike
    const y = (v: number) => t + (1 - v / top) * ph;
    const grid = [];
    const ystep = niceStep(top / 3);
    for (let v = ystep; v < top; v += ystep) {
      grid.push(<line key={`g${v}`} className="grid" x1={l} x2={w - r} y1={r1(y(v))} y2={r1(y(v))} />,
                <text key={`gt${v}`} className="axis-t" x={l + 2} y={r1(y(v)) - 3}>{v.toLocaleString()}</text>);
    }
    const xstep = X_STEPS.find((s) => d.span_ms / s <= pw / 70) || X_STEPS.at(-1)!;
    const ticks = [];
    for (let ms = 0; ms <= d.span_ms; ms += xstep) {
      const px = x(ms), anchor = px < l + 16 ? "start" : px > w - r - 16 ? "end" : "middle";
      ticks.push(<text key={ms} className="axis-t" x={r1(px)} y={DENS_H - 4} textAnchor={anchor}>{fmtTime(ms)}</text>);
    }

    // Current From/To filter, shaded.
    const from = parseTime(tFrom), to = parseTime(tTo);
    let range = null;
    if (from != null || to != null) {
      const x0 = x(from ?? 0), x1 = x(to != null ? to + 1000 : d.span_ms);
      if (x1 > x0) range = <rect className="range" x={r1(x0)} y={t} width={r1(x1 - x0)} height={ph} />;
    }

    // Each value counts chats from its bucket's start forward, so plot it at that start.
    const pts = d.nearby.map((v, i) => `${r1(x(i * d.bucket_ms))},${r1(y(v))}`);
    const first = pts[0].split(",")[0], last = pts.at(-1)!.split(",")[0];

    body = (
      <>
        {grid}
        <line className="grid" x1={l} x2={w - r} y1={y(0)} y2={y(0)} />
        {ticks}
        {range}
        <path className="area" d={`M${first},${y(0)}L${pts.join("L")}L${last},${y(0)}Z`} />
        <path className="line" d={"M" + pts.join("L")} />
        <rect className="brush" y={t} height={ph} visibility={brush ? "visible" : "hidden"}
              x={brush ? x(brush[0]) : undefined} width={brush ? x(brush[1]) - x(brush[0]) : undefined} />
        <line className="guide" y1={t} y2={t + ph} visibility={hover ? "visible" : "hidden"}
              x1={hover ? x(hover.at) : undefined} x2={hover ? x(hover.at) : undefined} />
        {d.peaks.map((p, i) => {
          const cx = r1(x(p.offset_ms)), cy = r1(y(p.count));
          return [
            <circle key={`p${i}`} className="peak" cx={cx} cy={cy} r={4} />,
            <circle key={`h${i}`} className="peak-hit" cx={cx} cy={cy} r={12} data-peak={i} />,
          ];
        })}
      </>
    );
  }

  return (
    <div className={"density" + (loading ? " loading" : "")} id="density" ref={box}>
      <svg id="density-svg" role="img" aria-label="Chat activity over stream time" ref={svg} height={DENS_H} {...handlers}>
        {body}
      </svg>
      {hover && d && (
        <div className="density-tip" id="density-tip" ref={tip}>
          <b>{hover.count.toLocaleString()}</b>
          {` chats in next ${fmtSpan(d.window_ms)} · ${fmtTime(hover.at)}${hover.peak ? " · click to zoom" : ""}`}
        </div>
      )}
      <div className="density-cap" id="density-cap">
        {!d ? "Loading chat activity…" : d.total
          ? `Chats in the next ${fmtSpan(d.window_ms)} from each moment · click to jump the table there · drag or click a peak to filter`
          : "No chats match these filters."}
      </div>
    </div>
  );
}
