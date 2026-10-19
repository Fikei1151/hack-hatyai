import { useEffect, useMemo, useRef, useState } from 'react';
import { num, thaiShort } from './format';

export interface ChartSeries {
  id: string;
  label: string;
  color: string;
  points: { t: number; v: number | null }[];
  kind: 'line' | 'step-area';
  dashed?: boolean;
  /** draw only the part before `now` at full strength; the rest is the plan */
  progress?: boolean;
}

interface Props {
  title: string;
  unit: string;
  total: number;
  now: number;
  startIso: string;
  series: ChartSeries[];
  refs?: { v: number; label: string }[];
  digits?: number;
  height?: number;
  yMin?: number;
}

const PAD = { l: 34, r: 8, t: 6, b: 16 };

/** Small time-series chart: one y-axis, recessive grid, crosshair + tooltip on hover. */
export function TimeChart({ title, unit, total, now, startIso, series, refs = [], digits = 1, height = 84, yMin }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(280);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const iw = Math.max(40, w - PAD.l - PAD.r);
  const ih = height - PAD.t - PAD.b;
  const { lo, hi, ticks } = useMemo(() => {
    let mx = -Infinity;
    let mn = Infinity;
    for (const s of series)
      for (const p of s.points)
        if (p.v !== null && Number.isFinite(p.v)) {
          mx = Math.max(mx, p.v);
          mn = Math.min(mn, p.v);
        }
    for (const r of refs) {
      mx = Math.max(mx, r.v);
      mn = Math.min(mn, r.v);
    }
    if (!Number.isFinite(mx)) {
      mx = 1;
      mn = 0;
    }
    const lo0 = yMin ?? Math.min(0, mn);
    const span = niceStep((mx - lo0) / 3 || 1);
    const hi0 = Math.max(lo0 + span, Math.ceil(mx / span) * span);
    const lo1 = yMin ?? Math.floor(lo0 / span) * span;
    const t: number[] = [];
    for (let v = lo1; v <= hi0 + 1e-9; v += span) t.push(v);
    return { lo: lo1, hi: hi0, ticks: t };
  }, [series, refs, yMin]);

  const x = (t: number) => PAD.l + (Math.min(Math.max(t, 0), total) / Math.max(total, 1)) * iw;
  const y = (v: number) => PAD.t + ih - ((v - lo) / (hi - lo || 1)) * ih;

  const paths = series.map((s) => {
    const pts = s.points.filter((p) => p.v !== null) as { t: number; v: number }[];
    const build = (subset: { t: number; v: number }[]) => {
      if (!subset.length) return '';
      if (s.kind === 'step-area') {
        let d = `M${x(subset[0].t)},${y(lo)}`;
        subset.forEach((p, i) => {
          const tNext = subset[i + 1]?.t ?? p.t;
          d += `L${x(p.t)},${y(p.v)}L${x(tNext)},${y(p.v)}`;
        });
        return d + `L${x(subset[subset.length - 1].t)},${y(lo)}Z`;
      }
      return subset.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    };
    if (!s.progress) return { s, full: build(pts), past: '' };
    return { s, full: build(pts), past: build(pts.filter((p) => p.t <= now)) };
  });

  const hoverT = hover === null ? null : ((hover - PAD.l) / iw) * total;
  const readings =
    hoverT === null
      ? []
      : series.map((s) => {
          let best: { t: number; v: number | null } | null = null;
          for (const p of s.points) if (p.v !== null && (!best || Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT))) best = p;
          return { s, p: best };
        });

  return (
    <div ref={wrap} className="relative select-none">
      <div className="mb-0.5 flex items-baseline justify-between gap-2">
        <div className="text-[12px] font-medium text-ink">{title}</div>
        {series.length > 1 && (
          <div className="flex gap-2.5 text-[11px] text-ink-2">
            {series.map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1">
                <svg width="14" height="6" aria-hidden="true">
                  <line x1="0" x2="14" y1="3" y2="3" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '3 2' : undefined} />
                </svg>
                {s.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <svg
        width={w}
        height={height}
        role="img"
        aria-label={`${title} (${unit})`}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = e.clientX - r.left;
          setHover(px >= PAD.l && px <= PAD.l + iw ? px : null);
        }}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={PAD.l + iw} y1={y(t)} y2={y(t)} stroke="var(--color-grid)" strokeWidth="1" />
            <text x={PAD.l - 5} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--color-ink-3)" className="tabular">
              {num(t, t !== 0 && Math.abs(t) < 10 && !Number.isInteger(t) ? 1 : 0)}
            </text>
          </g>
        ))}
        <line x1={PAD.l} x2={PAD.l + iw} y1={y(lo)} y2={y(lo)} stroke="var(--color-base)" strokeWidth="1" />
        {refs.map((r) => (
          <g key={r.label}>
            <line x1={PAD.l} x2={PAD.l + iw} y1={y(r.v)} y2={y(r.v)} stroke="var(--color-ink-3)" strokeWidth="1" strokeDasharray="2 3" />
            <text x={PAD.l + iw - 2} y={y(r.v) - 2.5} textAnchor="end" fontSize="9.5" fill="var(--color-ink-3)">
              {r.label}
            </text>
          </g>
        ))}
        {paths.map(({ s, full, past }) =>
          s.kind === 'step-area' ? (
            <g key={s.id}>
              <path d={full} fill={s.color} opacity={s.progress ? 0.22 : 0.85} />
              {past && <path d={past} fill={s.color} opacity={0.9} />}
            </g>
          ) : (
            <g key={s.id}>
              <path d={full} fill="none" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '4 3' : undefined} opacity={s.progress ? 0.35 : 1} strokeLinejoin="round" />
              {past && <path d={past} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" />}
            </g>
          ),
        )}
        {now > 0 && now < total && <line x1={x(now)} x2={x(now)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--color-ink-2)" strokeWidth="1" opacity="0.6" />}
        {hover !== null && (
          <g>
            <line x1={hover} x2={hover} y1={PAD.t} y2={PAD.t + ih} stroke="var(--color-ink-2)" strokeWidth="1" />
            {readings.map(({ s, p }) =>
              p && p.v !== null ? <circle key={s.id} cx={x(p.t)} cy={y(p.v)} r="3.5" fill={s.color} stroke="var(--color-panel-solid)" strokeWidth="2" /> : null,
            )}
          </g>
        )}
        <text x={PAD.l} y={height - 3} fontSize="10" fill="var(--color-ink-3)">
          {thaiShort(new Date(Date.parse(startIso)))}
        </text>
        <text x={PAD.l + iw} y={height - 3} textAnchor="end" fontSize="10" fill="var(--color-ink-3)">
          {unit}
        </text>
      </svg>
      {hover !== null && hoverT !== null && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-line bg-panel-solid px-2 py-1 text-[11px] shadow-lg"
          style={{ left: Math.min(Math.max(hover - 70, 0), w - 150), top: 18 }}
        >
          <div className="text-ink-3">{thaiShort(new Date(Date.parse(startIso) + hoverT * 1000))}</div>
          {readings.map(({ s, p }) => (
            <div key={s.id} className="flex items-center gap-1.5 text-ink">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
              {series.length > 1 && <span className="text-ink-2">{s.label}</span>}
              <span className="tabular font-medium">{p && p.v !== null ? `${num(p.v, digits)} ${unit}` : '–'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}
