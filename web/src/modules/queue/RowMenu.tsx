// The overflow menu on a merge queue row: hold, Backlog and, for batch members, remove from batch (which holds the PR). Whoever runs the repo.
import { DropdownMenu } from "radix-ui";
import { ArchiveIcon, DotsThreeIcon, PauseIcon, SignOutIcon } from "@phosphor-icons/react";
import { useApi } from "../../api/client";
import { useUser } from "../../shell/UserContext";
import { canRun } from "../../registry/permissions";
import { ErrorLine, useWrite } from "../admin/parts";

const menuCls = "z-50 min-w-[200px] rounded-md border border-line-strong bg-raised p-1 shadow-[0_12px_32px_rgba(0,0,0,0.28)] animate-rise";
const itemCls = "flex h-8 cursor-default items-center gap-2.5 rounded px-2 text-sm outline-none data-[highlighted]:bg-ink/[0.07] max-md:h-11";

/** `backlog`: the row may be put on the Backlog (it is not there already). */
export function RowMenu({ repo, number, inBatch, backlog }: { repo: string; number: number; inBatch?: boolean; backlog?: boolean }) {
  const api = useApi();
  const write = useWrite();
  if (!canRun(useUser(), repo)) return null;
  const ref = `${repo}#${number}`;
  const run = (key: string, f: () => Promise<unknown>) => () => void write.run(key, f);
  const send = (word: string) => async () => {
    const r = await api.maintainItem.command(repo, number, word);
    if (!r.ok) throw new Error(r.lines.join(" "));
  };
  return (
    <span className="relative z-10 inline-flex flex-col items-end">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label={`Actions for ${ref}`} className="inline-flex size-7 items-center justify-center rounded text-ink/60 outline-none hover:bg-ink/[0.07] hover:text-ink data-[state=open]:bg-ink/[0.07] max-md:size-11">
            <DotsThreeIcon size={20} weight="bold" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className={menuCls}>
            <DropdownMenu.Item className={itemCls} onSelect={run("hold", send("hold"))}>
              <PauseIcon size={16} />
              Hold
            </DropdownMenu.Item>
            {backlog && (
              <DropdownMenu.Item className={itemCls} onSelect={run("backlog", send("backlog"))}>
                <ArchiveIcon size={16} />
                Backlog
              </DropdownMenu.Item>
            )}
            {inBatch && (
              <DropdownMenu.Item className={itemCls} onSelect={run("batch", () => api.queueControl.batchRemove(ref))}>
                <SignOutIcon size={16} />
                Remove from batch
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ErrorLine error={write.error} className="max-w-[180px] text-2xs" />
    </span>
  );
}
