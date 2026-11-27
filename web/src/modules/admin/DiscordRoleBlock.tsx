import { useEffect, useState } from "react";
import type { DiscordSetup } from "../../api/types";
import { t } from "../../../../src/i18n/index.ts";
import { Badge, type Tone } from "../../ui/atoms/Badge";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Input } from "../../ui/atoms/Input";
import { Select } from "../../ui/atoms/Select";
import { TimeAgo } from "../../ui/atoms/TimeAgo";
import { ConfirmButton } from "../../ui/molecules/ConfirmButton";
import { Block } from "../../ui/molecules/Block";
import { useWrite } from "../../lib/hooks";

const ID = /^\d{15,22}$/;

/** The contributor role panel: the channel its Verify button is posted in, the role it gives, and what the runner last did. */
export function DiscordRoleBlock({ panel, channels, onSave }: { panel: DiscordSetup["rolePanel"]; channels: DiscordSetup["channels"]; onSave: (p: { channelId: string; roleId: string } | null) => Promise<unknown> }) {
  const [channel, setChannel] = useState(panel.channelId ?? "");
  const [role, setRole] = useState(panel.roleId ?? "");
  useEffect(() => { setChannel(panel.channelId ?? ""); setRole(panel.roleId ?? ""); }, [panel.channelId, panel.roleId]);
  const write = useWrite();
  const on = panel.channelId !== null;
  const badRole = role.trim() !== "" && !ID.test(role.trim());
  const unchanged = channel === (panel.channelId ?? "") && role.trim() === (panel.roleId ?? "");
  const [label, tone]: [string, Tone] = !on ? [t("Off"), "neutral"] : panel.posted?.error ? [t("Not posted"), "bad"] : panel.posted?.messageId ? [t("Posted"), "ok"] : [t("Waiting for the runner"), "warn"];
  return (
    <Block className="mt-4" title={t("Contributor role")} aside={<Badge tone={tone}>{label}</Badge>}>
      <form
        className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => { e.preventDefault(); if (!badRole) void write.run("save", () => onSave({ channelId: channel, roleId: role.trim() })); }}
      >
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          {t("Panel channel")}
          <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">{t("Choose a channel")}</option>
            {channels.map((c) => <option key={c.channelId} value={c.channelId}>{`#${c.name ?? c.channelId} · ${c.guildName ?? c.guildId}`}</option>)}
          </Select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm">
          {t("Role id")}
          <Input value={role} onChange={(e) => setRole(e.target.value)} inputMode="numeric" maxLength={22} aria-invalid={badRole} aria-describedby={badRole ? "role-id-err" : undefined} className="num" />
        </label>
        <Button type="submit" variant="primary" disabled={write.busy !== null || badRole || channel === "" || role.trim() === "" || unchanged} className="max-sm:h-11">
          {t("Save")}
        </Button>
        {badRole && <div id="role-id-err" role="alert" className="text-xs text-bad sm:col-span-3">{t("A role id is digits only: in Discord, right-click the role and copy its id.")}</div>}
      </form>
      <ErrorLine error={write.error} className="mt-2" />
      {on && (
        <div className="mt-3 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-sm">
          <span className="min-w-0 flex-1 text-ink/70" role="status">
            {panel.posted?.error
              ? <span className="text-bad">{panel.posted.error}</span>
              : panel.posted?.messageId
                ? <>{t("Posted")} <TimeAgo iso={panel.posted.at} /></>
                : t("Not posted yet")}
          </span>
          <ConfirmButton label={t("Turn off")} confirmLabel={t("Confirm turn off")} loading={write.busy === "off"} onConfirm={() => void write.run("off", () => onSave(null))} />
        </div>
      )}
    </Block>
  );
}
