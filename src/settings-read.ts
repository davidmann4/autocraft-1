// The string-keyed settings reads, kept for callers that have not moved to `config(db)` of src/data/control.
export {
  deleteSetting, freshSettings, hasSetting, readSettingsSnapshot, rereadSettingsSnapshot, setting, settingRows, settings, withSettingsSnapshot, writeSetting,
} from "./data/control/index.ts";
export type { SettingsSnapshot, SnapshotOptions } from "./data/control/index.ts";
