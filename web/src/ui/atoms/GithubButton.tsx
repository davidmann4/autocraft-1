import { ArrowSquareOutIcon, GithubLogoIcon } from "@phosphor-icons/react";
import { cn } from "../cn";
import { safeHref } from "../safeHref";
import { t } from "../../../../src/i18n/index.ts";

/**
 * A small secondary button with the GitHub logo, a link to `href` in a new tab. The negative margin keeps the row's
 * height; an invisible hit area around it reaches 44 px on touch screens. It sets `relative z-10`,
 * so it stays clickable inside a stretched row.
 */
export function GithubButton({ href, label, className }: { href: string; label: string; className?: string }) {
  return (
    <a
      href={safeHref(href)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title="Open on GitHub"
      className={cn(
        "relative z-10 -my-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-line-strong bg-raised text-ink/70 hover:bg-ink/[0.06] hover:text-ink",
        "after:absolute after:left-1/2 after:top-1/2 after:size-7 after:-translate-x-1/2 after:-translate-y-1/2 [@media(pointer:coarse)]:after:size-11",
        className,
      )}
    >
      <GithubLogoIcon aria-hidden size="1.1em" weight="bold" />
    </a>
  );
}

/**
 * The page-level link to an item on GitHub: a bordered 44 px button reading "GitHub". On narrow screens only the logo shows;
 * the accessible name stays "GitHub".
 */
export function GithubLinkButton({ href, className }: { href: string; className?: string }) {
  return (
    <a
      href={safeHref(href)}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-md border border-line-strong bg-raised text-sm font-medium text-ink transition-colors duration-fast hover:bg-ink/[0.06] max-sm:w-11 sm:px-3.5",
        className,
      )}
    >
      <GithubLogoIcon aria-hidden weight="bold" className="text-[16px]" />
      <span className="max-sm:sr-only">GitHub</span>
      <span className="sr-only">{t(", opens in a new tab")}</span>
      <span aria-hidden className="text-xs text-ink/60 max-sm:hidden">
        <ArrowSquareOutIcon />
      </span>
    </a>
  );
}
