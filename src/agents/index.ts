// autocraft-server inference jev [N | on | off]
import { jevEnabled, jevOutage, setJevEnabled } from "./jev.ts";
import { loadLiveConfig, saveSettings } from "../data/control/index.ts";
import { openDb } from "../db/open.ts";

const USAGE = `usage: autocraft-server inference jev [<N> | on | off]   Jev calls at once (1 to 100), or switch Jev on or off; shows the setting and whether Jev is in use`;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const whole = (v: number, min: number, max: number): boolean => Number.isInteger(v) && v >= min && v <= max;

async function jev(args: string[]): Promise<void> {
  const db = await openDb();
  if (args.length > 1) die(USAGE);
  if (args[0] === "on" || args[0] === "off") await setJevEnabled(db, args[0] === "on", "cli");
  else if (args[0] !== undefined) {
    const n = Number(args[0]);
    if (!whole(n, 1, 100)) die("Jev calls at once must be a whole number from 1 to 100");
    await saveSettings(db, [{ key: "jev_parallel", value: String(n) }], "cli", { action: "account-change", target: "jev", details: { jevParallel: n } });
  }
  console.log(`Jev calls at once: ${(await loadLiveConfig(db)).jevParallel}`);
  const o = await jevOutage(db);
  console.log(o ? `Jev unavailable (${o.reason}) since ${o.since}; Haiku does its work` : await jevEnabled(db) ? "Jev in use" : "Jev off");
}

export const commands = {
  inference: {
    summary: "Model calls: jev [N | on | off]",
    run: async (args: string[]) => {
      if (args[0] === "jev") await jev(args.slice(1));
      else die(USAGE);
    },
  },
};
