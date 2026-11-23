import type { DiscordUsage } from "../../api/types";
import { Badge } from "../../ui/atoms/Badge";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { Block } from "../../ui/molecules/Block";
import { ItemRef } from "../../ui/molecules/ItemRef";
import { TextLink } from "../../ui/atoms/TextLink";

const COUNT_ROWS: ["started" | "junk" | "filed" | "link" | "limits", string][] = [
  ["started", "Reports started"], ["junk", "Refused as junk"], ["filed", "Filed by the bot"], ["link", "Sent to Open on GitHub"], ["limits", "Turned away by limits"],
];

/** Dollars with the decimals a sub-cent call needs. */
const usd = (v: number): string => (v === 0 ? "$0" : v < 1 ? "$" + v.toFixed(4) : "$" + v.toFixed(2));
const sum = (rows: DiscordUsage["prompts"], w: "day" | "week", f: "calls" | "usd"): number => rows.reduce((n, p) => n + p[w][f], 0);

const TH = "px-4 py-1.5 text-2xs font-medium uppercase tracking-wide text-ink/45";

export function DiscordUsageBlock({ usage }: { usage: DiscordUsage }) {
  const cap = usage.capacity;
  return (
    <Block className="mt-4" title="Usage" aside={cap && <Badge tone={cap.ready ? "ok" : "warn"}>{cap.ready ? "Task Runner ready" : "No Task Runner"}</Badge>} flush>
      {cap && !cap.ready && cap.why && <div className="border-b border-line px-4 py-2 text-sm text-ink/70">{cap.why}</div>}
      <table className="w-full text-sm">
        <thead><tr><th className={TH + " text-left"}>Issue flow</th><th className={TH + " text-right"}>24 h</th><th className={TH + " text-right"}>7 d</th></tr></thead>
        <tbody>
          {COUNT_ROWS.map(([k, label]) => (
            <tr key={k} className="border-t border-line">
              <td className="px-4 py-1.5">{label}</td>
              <td className="num px-4 py-1.5 text-right">{usage.counts[k].day}</td>
              <td className="num px-4 py-1.5 text-right">{usage.counts[k].week}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-full border-t border-line text-sm">
        <thead><tr><th className={TH + " text-left"}>Model calls</th><th className={TH + " text-right"}>24 h</th><th className={TH + " text-right"}>7 d</th></tr></thead>
        <tbody>
          {usage.prompts.length === 0 && <tr className="border-t border-line"><td colSpan={3} className="px-4 py-2 text-ink/55">No Discord model calls yet.</td></tr>}
          {usage.prompts.map((p) => (
            <tr key={p.prompt} className="border-t border-line align-top">
              <td className="code px-4 py-1.5">{p.prompt.replace(/^discord\./, "")}</td>
              <td className="num whitespace-nowrap px-4 py-1.5 text-right">{p.day.calls} · {usd(p.day.usd)}</td>
              <td className="num whitespace-nowrap px-4 py-1.5 text-right">{p.week.calls} · {usd(p.week.usd)}</td>
            </tr>
          ))}
          {usage.prompts.length > 0 && (
            <tr className="border-t border-line font-medium">
              <td className="px-4 py-1.5">Total</td>
              <td className="num whitespace-nowrap px-4 py-1.5 text-right">{sum(usage.prompts, "day", "calls")} · {usd(sum(usage.prompts, "day", "usd"))}</td>
              <td className="num whitespace-nowrap px-4 py-1.5 text-right">{sum(usage.prompts, "week", "calls")} · {usd(sum(usage.prompts, "week", "usd"))}</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className={TH + " border-t border-line"}>Filed in the last 24 h</div>
      {usage.filed.length === 0 && <div className="border-t border-line px-4 py-2 text-sm text-ink/55">No issue filed from Discord.</div>}
      <ul>
        {usage.filed.map((f) => (
          <li key={f.repo + "#" + f.number} className="flex min-h-11 items-center gap-3 border-t border-line px-4 py-1.5">
            <div className="min-w-0 flex-1">{f.githubUrl ? <TextLink href={f.githubUrl} className="code block truncate text-sm">{f.repo}#{f.number}</TextLink> : <ItemRef repo={f.repo} number={f.number} kind="issue" title={null} size="sm" />}</div>
            <span className="max-w-[7rem] truncate text-2xs text-ink/55">{f.login}</span>
            <span className="text-2xs text-ink/45"><TimeAgo iso={f.at} /></span>
          </li>
        ))}
      </ul>
    </Block>
  );
}
