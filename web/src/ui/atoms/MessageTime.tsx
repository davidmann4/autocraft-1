import { messageTime, when } from "../../lib/format";

/** A clock time ("14:32"), with the date before it on other days ("Nov 3 14:32"). The tooltip shows the full time in the viewer's time zone. */
export function MessageTime({ iso, className }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} title={when(iso)} className={className ?? "num"}>
      {messageTime(iso)}
    </time>
  );
}
