import { useState, type ReactNode } from "react";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import { cn } from "../cn";

const remembered = new Map<string, boolean>();

/** Open state kept in memory for the page session, keyed by `key`; it survives unmounting but not a reload. */
export function useRememberedOpen(key: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(remembered.get(key) ?? false);
  return [open, (next) => { remembered.set(key, next); setOpen(next); }];
}

/** Full-width button that shows or hides the region `controls` names. The caller renders that region (with that id) only while `open`. */
export function DisclosureButton({ open, onToggle, controls, children, className }: {
  open: boolean; onToggle: (open: boolean) => void; controls: string; children: ReactNode; className?: string;
}) {
  const Caret = open ? CaretUpIcon : CaretDownIcon;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={() => onToggle(!open)}
      className={cn("flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium text-ink/70 outline-none hover:bg-ink/[0.025] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60", className)}
    >
      <Caret aria-hidden="true" className="shrink-0" />
      {children}
    </button>
  );
}
