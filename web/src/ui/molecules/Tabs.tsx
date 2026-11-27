import { useRef, type KeyboardEvent } from "react";
import { cn } from "../cn";

/**
 * Underlined tabs (WAI-ARIA tabs pattern): the selected tab is the only one in the tab order; arrow keys, Home and End move
 * between tabs and select them. `idBase` names the tabs `${idBase}-tab-${value}` and their panels `${idBase}-panel-${value}`.
 * Callers render only the selected tab's panel, so only the selected tab points at its panel with `aria-controls`.
 */
export function Tabs<T extends string>({ value, options, onChange, label, idBase, className }: {
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (v: T) => void;
  label: string;
  idBase: string;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (e: KeyboardEvent, i: number) => {
    const last = options.length - 1;
    const to = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (to === null) return;
    e.preventDefault();
    onChange(options[to]!.value);
    refs.current[to]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={cn("flex gap-1 max-md:gap-0 overflow-x-auto border-b border-line scrollbar-none", className)}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => void (refs.current[i] = el)}
            id={`${idBase}-tab-${o.value}`}
            role="tab"
            aria-selected={on}
            aria-controls={on ? `${idBase}-panel-${o.value}` : undefined}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => move(e, i)}
            className={cn(
              "-mb-px inline-flex h-10 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm max-md:px-2 max-md:h-11",
              on ? "border-accent font-semibold text-ink" : "border-transparent text-ink/70 hover:text-ink",
            )}
          >
            {o.label}
            {o.count !== undefined && <span className="num rounded-full bg-ink/[0.08] px-1.5 text-2xs">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
