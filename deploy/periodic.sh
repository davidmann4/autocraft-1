#!/bin/bash
# The periodic chores of a container install: the work of the systemd sync timer (sync every 60 seconds after the
# previous run ends) and, on SQLite, of the daily backup timer (keeping 7). `autocraft-server periodic` runs this while
# its copy leads the periodic role (src/periodic.ts), so of two replicas only one runs the chores.
set -uo pipefail
cd "$(dirname "$0")/.."
trap 'exit 0' TERM INT
# A Postgres database (AUTOCRAFT_DB_URL) is backed up by its provider; the snapshot covers SQLite only.
snapshots=1
if [ -n "${AUTOCRAFT_DB_URL:-${CRAFT_AUTO_DB_URL:-}}" ]; then
  snapshots=0
  echo "backup: AUTOCRAFT_DB_URL is set; no snapshots here, the database provider keeps the backups" >&2
fi
# The directory deploy/backup.sh writes to.
db="${AUTOCRAFT_DB:-${CRAFT_AUTO_DB:-}}"
data_dir="${AUTOCRAFT_DATA_DIR:-${CRAFT_AUTO_DATA_DIR:-}}"
[ -n "$db" ] || [ -z "$data_dir" ] || db="$data_dir/mirror.db"
backups="${AUTOCRAFT_BACKUP_DIR:-$(dirname "${db:-.}")/backups}"
# Time of the newest daily snapshot (0 when there is none), so a restart does not reset the schedule.
last_backup() {
  f=$(ls -1t "$backups"/daily-*.db.* 2>/dev/null | head -n 1)
  if [ -n "$f" ]; then stat -c %Y "$f"; else echo 0; fi
}
while true; do
  # A run that does not end within 15 minutes is stopped, so the loop always goes on.
  timeout --kill-after=30s 900 node --no-warnings src/cli.ts sync || echo "sync exited $?" >&2
  if [ "$snapshots" = 1 ] && [ $(( $(date +%s) - $(last_backup) )) -ge 86400 ]; then
    bash deploy/backup.sh daily 7 || echo "backup exited $?" >&2
  fi
  sleep 60 & wait $!
done
