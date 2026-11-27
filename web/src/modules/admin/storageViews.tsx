// Admin: where model-call transcripts are stored, an S3-compatible bucket or (one replica only) a local directory, with a probe test.
import { useEffect, useState } from "react";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { t } from "../../../../src/i18n/index.ts";
import { useApi, useQuery } from "../../api/client";
import type { TranscriptStoreInput, TranscriptStoreStatus } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { useWrite } from "../../lib/hooks";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { Block } from "../../ui/molecules/Block";
import { Page } from "../../ui/organisms/Page";
import { cn } from "../../ui/cn";
import { TextInput } from "./parts";

const SOURCE: Record<NonNullable<TranscriptStoreStatus["active"]>["source"], string> = {
  settings: "Saved here",
  environment: "From the environment",
};

type Form = { kind: "local" | "s3"; endpoint: string; bucket: string; prefix: string; accessKeyId: string; secretAccessKey: string };

const formOf = (s: TranscriptStoreStatus): Form => {
  const v = s.saved ?? s.active;
  if (!v) return { kind: "s3", endpoint: "", bucket: "", prefix: "", accessKeyId: "", secretAccessKey: "" };
  return { kind: v.kind, endpoint: v.endpoint ?? "", bucket: v.bucket ?? "", prefix: v.prefix, accessKeyId: v.accessKeyId ?? "", secretAccessKey: "" };
};
const inputOf = (f: Form): TranscriptStoreInput =>
  f.kind === "local" ? { kind: "local" } : { kind: "s3", endpoint: f.endpoint.trim(), bucket: f.bucket.trim(), prefix: f.prefix.trim(), accessKeyId: f.accessKeyId.trim(), ...(f.secretAccessKey && { secretAccessKey: f.secretAccessKey }) };

function Active({ s }: { s: TranscriptStoreStatus }) {
  const a = s.active;
  if (!a) return <p className="text-sm">{t("Off: model-call transcripts are not stored.")}</p>;
  const rows: [string, string][] =
    a.kind === "s3"
      ? [
          [t("Store"), t("S3-compatible bucket")],
          [t("Bucket"), a.bucket ?? ""],
          [t("Endpoint"), a.endpoint ?? ""],
          [t("Prefix"), a.prefix || "–"],
          [t("Access key id"), a.accessKeyId ?? ""],
        ]
      : [
          [t("Store"), t("Local directory (single replica only)")],
          [t("Directory"), a.dir ?? ""],
        ];
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink/60">{k}</dt>
          <dd className={cn("break-all", k !== t("Store") && "code")}>{v}</dd>
        </div>
      ))}
      <dt className="text-ink/60">{t("Configured")}</dt>
      <dd>{t(SOURCE[a.source])}</dd>
    </dl>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-ink/75">{label}</span>
      {children}
    </label>
  );
}

function TranscriptStore() {
  const api = useApi();
  const { data, error, refetch } = useQuery("transcript-store", (a) => a.transcriptStore.status());
  const write = useWrite();
  const [form, setForm] = useState<Form | null>(null);
  const [probe, setProbe] = useState<{ ok: boolean; detail: string } | null>(null);
  useEffect(() => {
    if (data && form === null) setForm(formOf(data));
  }, [data]);
  if (!data || !form) return error ? <ErrorLine error={error.message} className="mt-4" /> : null;
  const set = (patch: Partial<Form>) => {
    setForm({ ...form, ...patch });
    setProbe(null);
  };
  const s3 = form.kind === "s3";
  const complete = !s3 || (form.endpoint.trim() && form.bucket.trim() && form.accessKeyId.trim() && (form.secretAccessKey || data.saved?.secretSet));
  const save = () =>
    void write.run("save", async () => {
      const next = await api.transcriptStore.save(inputOf(form));
      setForm(formOf(next));
      await refetch();
    });
  const test = () =>
    void write.run("test", async () => {
      setProbe(await api.transcriptStore.test(inputOf(form)));
    });
  const clear = () =>
    void write.run("clear", async () => {
      const next = await api.transcriptStore.clear();
      setForm(formOf(next));
      setProbe(null);
      await refetch();
    });
  return (
    <div className="mt-4 flex flex-col gap-4">
      <Block title={t("Transcripts are stored in")}>
        <Active s={data} />
        {data.problem && <ErrorLine error={data.problem} className="mt-2" />}
      </Block>
      <Block title={t("Transcript storage")}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">{t("Store")}</legend>
            {(["s3", "local"] as const).map((k) => (
              <label key={k} className={cn("flex h-11 cursor-pointer items-center gap-2 rounded border px-3 text-sm", form.kind === k ? "border-accent bg-accent/10" : "border-line")}>
                <input type="radio" name="transcript-store-kind" value={k} checked={form.kind === k} onChange={() => set({ kind: k })} />
                {k === "local" ? t("Local directory (single replica only)") : t("S3-compatible bucket")}
              </label>
            ))}
          </fieldset>
          {s3 && (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t("Endpoint")}>
                <TextInput value={form.endpoint} onChange={(e) => set({ endpoint: e.target.value })} inputMode="url" autoComplete="off" spellCheck={false} className="w-full" />
              </Field>
              <Field label={t("Bucket")}>
                <TextInput value={form.bucket} onChange={(e) => set({ bucket: e.target.value })} autoComplete="off" spellCheck={false} className="w-full" />
              </Field>
              <Field label={t("Prefix")}>
                <TextInput value={form.prefix} onChange={(e) => set({ prefix: e.target.value })} autoComplete="off" spellCheck={false} className="w-full" />
              </Field>
              <Field label={t("Access key id")}>
                <TextInput value={form.accessKeyId} onChange={(e) => set({ accessKeyId: e.target.value })} autoComplete="off" spellCheck={false} className="w-full" />
              </Field>
              <Field label={t("Secret access key")}>
                <TextInput
                  type="password"
                  value={form.secretAccessKey}
                  onChange={(e) => set({ secretAccessKey: e.target.value })}
                  autoComplete="new-password"
                  placeholder={data.saved?.secretSet ? t("Saved") : ""}
                  className="w-full"
                />
              </Field>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" variant="primary" disabled={!complete} loading={write.busy === "save"} className="max-md:h-11">
              {t("Save")}
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={!complete} loading={write.busy === "test"} onClick={test} className="max-md:h-11">
              {t("Test")}
            </Button>
            {data.saved && (
              <Button type="button" size="sm" variant="ghost" loading={write.busy === "clear"} onClick={clear} className="max-md:h-11">
                {data.environment ? t("Use the environment's bucket") : t("Turn transcripts off")}
              </Button>
            )}
          </div>
          {probe && (
            <p role="status" className={cn("flex items-start gap-1.5 text-sm", probe.ok ? "text-ok" : "text-bad")}>
              {probe.ok ? <CheckCircleIcon aria-hidden className="mt-0.5 shrink-0" /> : <WarningCircleIcon aria-hidden className="mt-0.5 shrink-0" />}
              {probe.detail}
            </p>
          )}
          <ErrorLine error={write.error} />
        </form>
      </Block>
    </div>
  );
}

export function StorageView(_: ViewProps) {
  return (
    <Page title={t("Storage")}>
      <TranscriptStore />
    </Page>
  );
}
