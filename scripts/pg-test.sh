#!/usr/bin/env bash
# A throwaway Postgres for tests, in Docker (rootless works): data on tmpfs, fsync off, a free loopback port.
#
#   scripts/pg-test.sh start                      prints "<container id> <url>"
#   scripts/pg-test.sh stop <container id>        removes it
#   scripts/pg-test.sh run [--latency MS] [test files...]
#       starts one, runs the test files (default: the Postgres tests) with AUTOCRAFT_TEST_PG_URL set, removes it.
#       --latency routes the connections through scripts/latency-proxy.ts with MS each way (10 if no number follows).
#   scripts/pg-test.sh suite [--concurrency N] [test files...]
#       starts one, runs the test files (default: the whole suite) on it with test/pg-suite-preload.ts loaded, so every
#       connectDb on a SQLite path opens a Postgres database (test/pg-suite.ts); prints the totals and the failures per
#       file (scripts/pg-suite-report.ts), writes the spec output to a log, removes the container.
#
# `pnpm test:pg` is `run`; `pnpm test:pg:suite` is `suite`.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${AUTOCRAFT_TEST_PG_IMAGE:-postgres:18}"
# Size of the tmpfs the data lives on; a copy of a production database needs more than tests do.
TMPFS_SIZE="${AUTOCRAFT_TEST_PG_TMPFS:-2g}"
DEFAULT_TESTS=(test/pg-db.test.ts test/itemtools-pg.test.ts test/pg-copy.test.ts test/kx.test.ts test/portable.test.ts)

# Rootless Docker listens on a per-user socket; use it when DOCKER_HOST is unset and it exists.
if [[ -z "${DOCKER_HOST:-}" && -S "/run/user/$(id -u)/docker.sock" ]]; then
  export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
fi

start() {
  local id hostport
  # The suite runs one test file per CPU, each opening pools of up to 8 connections plus those of the processes it
  # spawns: about 10 to 15 a file at their peak, so 16 CPUs need more than the default 100 and than 200.
  id=$(docker run -d --rm -e POSTGRES_PASSWORD=test -p 127.0.0.1::5432 \
    --tmpfs "/var/lib/postgresql:rw,size=${TMPFS_SIZE}" "$IMAGE" \
    -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=300)
  # The image's init runs a server on the Unix socket only, then restarts it on TCP: ready means ready over TCP.
  for _ in $(seq 1 120); do
    if docker exec "$id" pg_isready -q -h 127.0.0.1 -U postgres 2>/dev/null; then
      hostport=$(docker port "$id" 5432/tcp | head -n 1)
      echo "$id postgres://postgres:test@${hostport}/postgres"
      return 0
    fi
    sleep 0.5
  done
  docker logs "$id" 2>&1 | tail -20 >&2
  docker rm -f "$id" >/dev/null
  echo "pg-test: Postgres did not become ready" >&2
  return 1
}

stop() {
  docker rm -f "$1" >/dev/null
}

run() {
  local latency="" files=()
  while (($#)); do
    case "$1" in
      --latency)
        if [[ "${2:-}" =~ ^[0-9]+$ ]]; then latency="$2"; shift; else latency=10; fi ;;
      *) files+=("$1") ;;
    esac
    shift
  done
  ((${#files[@]})) || files=("${DEFAULT_TESTS[@]}")
  # Globals, not locals: the EXIT trap runs after this function has returned.
  local out url
  proxy_pid=""
  out=$(start)
  id=${out%% *}
  url=${out#* }
  proxy_out=$(mktemp)
  trap 'rm -f "$proxy_out"; [[ -n "$proxy_pid" ]] && kill "$proxy_pid" 2>/dev/null; stop "$id"' EXIT
  if [[ -n "$latency" ]]; then
    local target=${url#*@}
    target=${target%%/*}
    node --no-warnings scripts/latency-proxy.ts "$target" --delay "$latency" >"$proxy_out" &
    proxy_pid=$!
    for _ in $(seq 1 50); do [[ -s "$proxy_out" ]] && break; sleep 0.1; done
    url="${url%%@*}@$(head -n 1 "$proxy_out")/postgres"
    echo "pg-test: ${latency} ms each way through $(head -n 1 "$proxy_out")" >&2
  fi
  AUTOCRAFT_TEST_PG_URL="$url" node --test --no-warnings "${files[@]}"
}

suite() {
  local conc="" files=()
  while (($#)); do
    case "$1" in
      --concurrency) conc="${2:?--concurrency needs a number}"; shift ;;
      *) files+=("$1") ;;
    esac
    shift
  done
  local out url log
  out=$(start)
  id=${out%% *}
  url=${out#* }
  trap 'stop "$id"' EXIT
  log=$(mktemp "${TMPDIR:-/tmp}/pg-suite-XXXXXX.log")
  echo "pg-test: container ${id:0:12}, spec output in $log" >&2
  # NODE_OPTIONS, not a node flag: processes the tests spawn (the CLI, workers' children) redirect too.
  AUTOCRAFT_TEST_PG_URL="$url" NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=$PWD/test/pg-suite-preload.ts" \
    node --test --no-warnings ${conc:+--test-concurrency="$conc"} \
      --test-reporter=spec --test-reporter-destination="$log" \
      --test-reporter="$PWD/scripts/pg-suite-report.ts" --test-reporter-destination=stdout \
      "${files[@]}"
}

case "${1:-}" in
  start) start ;;
  suite) shift; suite "$@" ;;
  stop) stop "${2:?container id}" ;;
  run) shift; run "$@" ;;
  *) sed -n "2,14p" "$0" >&2; exit 2 ;;
esac
