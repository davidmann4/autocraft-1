// The top of Stats: tiles for a period and merges per day. One series, so no legend: the heading names it.
import { useEffect, useRef, useState } from "react";
import { t } from "../../../../../src/i18n/index.ts";
import { useQuery } from "../../../api/client";
import { Pending } from "../../../ui/atoms/Pending";
import { Segmented } from "../../../ui/molecules/Segmented";
import { cn } from "../../../ui/cn";
import { num } from "../../../lib/format";

type Period = "7d" | "30d";

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-line bg-raised px-3 py-2.5">
      <span className="text-xs text-ink/70">{label}</span>
      <span className="num text-2xl font-semibold leading-8">{value}</span>
      {sub && <span className="text-xs text-ink/70">{sub}</span>}
    </div>
  );
}

/** The element's width, so the chart is drawn at its shown size and its labels keep theirs on phones. */
function useBoxWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(Math.max(240, Math.round(el.getBoundingClientRect().width)));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const shortDay = (d: string) => d.slice(5);

/** Bars grow from the baseline with rounded data ends; hover or focus names a day's value. */
function MergedChart({ data }: { data: { day: string; n: number }[] }) {
  const [hot, setHot] = useState<number | null>(null);
  const [ref, W] = useBoxWidth();
  const H = 170, pad = 28, top = 8;
  const max = Math.max(1, ...data.map((d) => d.n));
  const ceil = Math.max(4, Math.ceil(max / 4) * 4);
  const slot = (W - pad) / data.length;
  const bw = Math.max(3, Math.min(slot * 0.6, 28));
  const y = (n: number) => top + (H - top - 18) * (1 - n / ceil);
  const base = y(0);
  const shown = hot ?? data.length - 1;
  const last = data.length - 1;
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-semibold">{t("Merged per day")}</span>
        <span className="num text-ink/80" aria-live="polite">
          {t("{day}: {n} merged", { day: data[shown]!.day, n: data[shown]!.n })}
        </span>
      </figcaption>
      <div ref={ref}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full" role="img" aria-label={t("Merged per day, {from} to {to}, highest {max}", { from: data[0]!.day, to: data[last]!.day, max })} onMouseLeave={() => setHot(null)}>
          {[0, ceil / 2, ceil].map((v) => (
            <g key={v}>
              <line x1={pad} x2={W} y1={y(v)} y2={y(v)} className="stroke-line" strokeWidth={1} />
              <text x={pad - 6} y={y(v) + 4} textAnchor="end" className="fill-ink/60 text-[12px]">
                {v}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = pad + i * slot + (slot - bw) / 2;
            const h = Math.max(0, base - y(d.n));
            const r = Math.min(4, bw / 2, h);
            return (
              <g key={d.day} tabIndex={0} role="img" aria-label={t("{day}: {n} merged", { day: d.day, n: d.n })} onMouseEnter={() => setHot(i)} onFocus={() => setHot(i)} onBlur={() => setHot(null)} className="outline-none [&:focus-visible>rect:last-child]:stroke-accent">
                <rect x={pad + i * slot} y={top} width={slot} height={base - top} fill="transparent" />
                <path d={`M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + bw - r} Q${x + bw},${base - h} ${x + bw},${base - h + r} V${base} Z`} className={cn("fill-accent transition-opacity", hot !== null && hot !== i && "opacity-50")} />
                <rect x={x - 1} y={base - h - 1} width={bw + 2} height={h + 2} fill="none" strokeWidth={2} className="stroke-transparent" />
              </g>
            );
          })}
          {data.map((d, i) =>
            data.length <= 7 || i === 0 || i === last ? (
              <text key={d.day} x={Math.min(W - 16, Math.max(16, pad + i * slot + slot / 2))} y={H - 2} textAnchor="middle" className="fill-ink/60 text-[12px]">
                {shortDay(d.day)}
              </text>
            ) : null,
          )}
        </svg>
      </div>
      <details className="text-sm">
        <summary className="inline-flex h-11 cursor-pointer items-center text-ink/80">{t("Show as table")}</summary>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-ink/70">
              <th className="font-medium">{t("Day")}</th>
              <th className="font-medium">{t("Merged")}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.day}>
                <td>{d.day}</td>
                <td className="num">{d.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

export function Headline() {
  const [period, setPeriod] = useState<Period>("7d");
  const { data: s, error } = useQuery(`maintain-stats:${period}`, (a) => a.maintain.stats(period));
  const days = period === "7d" ? 7 : 30;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t("Stats")}</h1>
        <Segmented<Period> label={t("Period")} value={period} onChange={setPeriod} options={[{ value: "7d", label: t("7 days") }, { value: "30d", label: t("30 days") }]} />
      </div>
      {!s ? (
        <Pending error={error} />
      ) : (
        <>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
            <Tile label={t("Items merged")} value={num(s.merged)} />
            <Tile label={t("Issues implemented")} value={num(s.implemented)} />
            <Tile label={t("PRs reviewed")} value={num(s.reviewed)} />
            <Tile label={t("Open backlog now")} value={num(s.backlog)} sub={t("{change} in {days} days", { change: `${s.backlogChange < 0 ? "−" : "+"}${num(Math.abs(s.backlogChange))}`, days })} />
            <Tile label={t("Model spend")} value={`$${num(s.spend)}`} />
          </div>
          <MergedChart data={s.perDay} />
        </>
      )}
    </div>
  );
}
