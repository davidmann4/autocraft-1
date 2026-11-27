// Labels, icons and costs of the item trace.
import {
  ChatsIcon,
  DiscordLogoIcon,
  GearIcon,
  GithubLogoIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  QuestionIcon,
  ShieldCheckIcon,
  SparkleIcon,
  WrenchIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { TraceEvent, TraceKind } from "../api/types";

export const TRACE_KIND: Record<TraceKind, { label: string; Icon: PhosphorIcon }> = {
  "model-call": { label: "Model calls", Icon: SparkleIcon },
  github: { label: "GitHub", Icon: GithubLogoIcon },
  decision: { label: "Commands and answers", Icon: QuestionIcon },
  write: { label: "Writes", Icon: PencilSimpleIcon },
  check: { label: "Checks", Icon: ShieldCheckIcon },
  review: { label: "Reviews", Icon: MagnifyingGlassIcon },
  plan: { label: "Plan", Icon: ListChecksIcon },
  job: { label: "Jobs", Icon: GearIcon },
  step: { label: "Fixes and merges", Icon: WrenchIcon },
  conversation: { label: "Conversation", Icon: ChatsIcon },
  discord: { label: "Discord", Icon: DiscordLogoIcon },
};

export const TRACE_KINDS = Object.keys(TRACE_KIND) as TraceKind[];

/** "$0.91", or "<$0.01" below a cent; null (not recorded or still running) shows nothing. */
export const formatCost = (usd: number | null | undefined): string | null => (usd === null || usd === undefined ? null : usd >= 0.01 ? `$${usd.toFixed(2)}` : "<$0.01");

/** The cost a timeline row shows: a review's summed cost, a call's own, or the sum over a group of calls. */
export function eventCost(e: TraceEvent): string | null {
  return formatCost(e.costUsd !== undefined ? e.costUsd : e.call?.costUsd);
}
