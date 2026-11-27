// The settled label and Discord mentions of fake items.
import type { Settled, TypeLabel } from "../types";
import { NOW, rng } from "./fixtures";

const LABELS: TypeLabel[] = ["bugfix", "performance", "missing feature", "small extra", "plugin candidate", "infra"];

export function settledFor(seed: number): Settled {
  const r = rng(seed * 7919 + 13);
  const jev = LABELS[Math.floor(r() * LABELS.length)];
  const top = Math.round((0.45 + r() * 0.55) * 100) / 100;
  const flags = r() < 0.08 ? ["security"] : r() < 0.2 ? ["needs decision"] : [];
  if (r() < 0.04) return { status: "unclassified", label: null, source: null, confidence: null, jevLabel: null, haikuLabel: null, flags: [], referee: null };
  if (top >= 0.9) return { status: "settled", label: jev, source: "jev", confidence: top, jevLabel: jev, haikuLabel: null, flags, referee: null };
  const x = r();
  if (x < 0.35) return { status: "waiting", label: null, source: null, confidence: top, jevLabel: jev, haikuLabel: null, flags, referee: null };
  const haiku = x < 0.85 ? jev : LABELS[(LABELS.indexOf(jev) + 1) % LABELS.length];
  return haiku === jev
    ? { status: "settled", label: jev, source: "haiku", confidence: top, jevLabel: jev, haikuLabel: haiku, flags, referee: null }
    : { status: "disagree", label: null, source: null, confidence: top, jevLabel: jev, haikuLabel: haiku, flags, referee: null };
}

/** Mock mentions: some items are named in watched Discord channels. */
export const mockDiscordCount = (number: number): number => (number % 4 === 0 ? 1 + (number % 3) : 0);
export const mockDiscordLinks = (number: number): { url: string; at: string }[] =>
  Array.from({ length: mockDiscordCount(number) }, (_, k) => ({
    url: `https://discord.com/channels/9000000000000001/9000000000000002/${9100000000000000 + number * 10 + k}`,
    at: new Date(NOW - (number % 50 + k * 19 + 1) * 3600_000).toISOString(),
  }));
