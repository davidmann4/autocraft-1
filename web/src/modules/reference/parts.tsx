// Pieces the reference pages share: the page frame, link rows and folds.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { Fold } from "../connect/Fold";

export function RefPage({ title, back, children }: { title: ReactNode; back?: { to: string; label: string }; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 pb-12 pt-5 md:px-6">
        {back && (
          <Link to={back.to} className="inline-flex h-11 w-fit items-center gap-1.5 rounded text-sm text-ink/70 hover:text-ink">
            <ArrowLeftIcon aria-hidden /> {back.label}
          </Link>
        )}
        <h1 className="text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function LinkRow({ to, title, line }: { to: string; title: ReactNode; line?: ReactNode }) {
  return (
    <li>
      <Link to={to} className="flex min-h-12 items-center gap-3 rounded px-3 py-2.5 hover:bg-ink/[0.04]">
        <span className="min-w-0 flex-1">
          <span className="block text-md font-medium">{title}</span>
          {line && <span className="block text-sm text-ink/70">{line}</span>}
        </span>
        <CaretRightIcon aria-hidden className="shrink-0 text-ink/60" />
      </Link>
    </li>
  );
}

export const List = ({ children }: { children: ReactNode }) => <ul className="divide-y divide-line rounded-lg border border-line bg-panel">{children}</ul>;

export const Loading = ({ error }: { error?: Error }) => <p className="text-sm text-ink/70">{error ? error.message : t("Loading.")}</p>;

export { Fold };
