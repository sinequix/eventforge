#!/usr/bin/env bash
# EventForge local stack: setup, supervise, and stop loopback services plus a
# named Cloudflare Tunnel at https://dev.eventforge.dev (local machine only).
#
#   ./dev.sh                 start (or reuse) the stack and supervise until Ctrl-C
#   ./dev.sh start --remote  local Worker/console, preview D1/R2
#   ./dev.sh stop
#   ./dev.sh status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$ROOT/.eventforge/dev"
LOG_DIR="$STATE_DIR/logs"
PID_DIR="$STATE_DIR/pids"
TUNNEL_NAME="eventforge-dev"
PUBLIC_HOST="dev.eventforge.dev"
PUBLIC_ORIGIN="https://${PUBLIC_HOST}"
API_PORT="${EVENTFORGE_API_PORT:-8788}"
CONSOLE_PORT="${EVENTFORGE_CONSOLE_PORT:-5174}"
CONTROL_PORT="${EVENTFORGE_CONTROL_PORT:-4310}"
API_ORIGIN="http://127.0.0.1:${API_PORT}"
CONSOLE_ORIGIN="http://127.0.0.1:${CONSOLE_PORT}"
CONTROL_ORIGIN="http://127.0.0.1:${CONTROL_PORT}"
ACCOUNT_ID="b9f5ebc6c05975fab56f056782461b77"
CLOUDFLARED_BIN="${EVENTFORGE_CLOUDFLARED_BIN:-cloudflared}"

COMMAND=""
REMOTE_TARGET=""

services=(api control console tunnel)

usage() {
  cat <<'EOF'
Usage: ./dev.sh [command] [--remote[=preview]]

Commands:
  up             Start missing services and supervise until Ctrl-C (default).
  start          Start missing services and return (idempotent).
  stop | down    Stop the stack this script started.
  status         Show PIDs and health.
  logs [name]    Tail logs (api, control, console, tunnel, or all).
  restart        Stop then start.

Flags:
  --remote              Local Worker against preview D1/R2.
  --remote=preview      Same as --remote.
  Production bindings are refused: development authentication must not access customer identities.

The public hostname is always https://dev.eventforge.dev via a named Cloudflare
Tunnel. Processes bind loopback only; the tunnel is the HTTPS front door.
Loopback http://127.0.0.1:5173 still bypasses hosted sign-in for operations.
EOF
}

die() {
  printf 'dev.sh: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

mkdirs() {
  mkdir -p "$LOG_DIR" "$PID_DIR"
}

pid_file() {
  printf '%s/%s.pid' "$PID_DIR" "$1"
}

log_file() {
  printf '%s/%s.log' "$LOG_DIR" "$1"
}

is_pid_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  local file
  file="$(pid_file "$1")"
  [[ -f "$file" ]] || return 1
  tr -d '[:space:]' <"$file"
}

stop_tree() {
  local pid="$1"
  is_pid_alive "$pid" || return 0
  local kids=""
  kids="$(pgrep -P "$pid" 2>/dev/null || true)"
  kill -TERM "$pid" $kids 2>/dev/null || true
  local _i
  for _i in 1 2 3 4 5 6 7 8 9 10; do
    is_pid_alive "$pid" || return 0
    sleep 0.2
  done
  kids="$(pgrep -P "$pid" 2>/dev/null || true)"
  kill -KILL "$pid" $kids 2>/dev/null || true
}

start_logged() {
  local name="$1"
  local dir="$2"
  shift 2
  local pidfile logfile
  pidfile="$(pid_file "$name")"
  logfile="$(log_file "$name")"
  if is_pid_alive "$(read_pid "$name" 2>/dev/null || true)"; then
    return 0
  fi
  rm -f "$pidfile"
  : >"$logfile"
  (
    cd "$dir"
    exec "$@"
  ) >>"$logfile" 2>&1 &
  echo $! >"$pidfile"
}

wait_http() {
  local url="$1"
  local label="$2"
  local attempts="${3:-60}"
  local i
  for i in $(seq 1 "$attempts"); do
    if curl -4 -fsS -o /dev/null --max-time 5 "$url" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  printf 'dev.sh: %s did not become ready at %s (see %s)\n' "$label" "$url" "$LOG_DIR" >&2
  return 1
}

# mDNSResponder / Tailscale can NXDOMAIN a name that 1.1.1.1 already serves.
# Health checks for the public hostname must not depend on getaddrinfo.
public_a_record() {
  dig +short @1.1.1.1 "$PUBLIC_HOST" A 2>/dev/null | grep -E '^[0-9.]+$' | head -1
}

wait_public() {
  local ip
  ip="$(public_a_record)"
  if [[ -z "$ip" ]]; then
    printf 'dev.sh: no public A record for %s via 1.1.1.1\n' "$PUBLIC_HOST" >&2
    return 1
  fi
  local i
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null --max-time 5 --resolve "${PUBLIC_HOST}:443:${ip}" "$PUBLIC_ORIGIN/" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  printf 'dev.sh: %s did not become ready at %s (see %s)\n' "$PUBLIC_HOST" "$PUBLIC_ORIGIN/" "$LOG_DIR" >&2
  return 1
}

parse_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      -h | --help)
        usage
        exit 0
        ;;
      --remote)
        REMOTE_TARGET="preview"
        ;;
      --remote=preview)
        REMOTE_TARGET="preview"
        ;;
      --remote=production)
        REMOTE_TARGET="production"
        ;;
      --remote=*)
        die "Unknown --remote value. Use preview or production."
        ;;
      up | start | stop | down | status | logs | restart)
        [[ -z "$COMMAND" ]] || die "Multiple commands: $COMMAND and $arg"
        COMMAND="$arg"
        ;;
      api | control | console | tunnel | all)
        [[ "$COMMAND" == "logs" ]] || die "Unexpected argument: $arg"
        FOLLOW_LOGS_NAME="$arg"
        ;;
      *)
        die "Unknown argument: $arg"
        ;;
    esac
  done
  COMMAND="${COMMAND:-up}"
  FOLLOW_LOGS_NAME="${FOLLOW_LOGS_NAME:-all}"
}

ensure_install() {
  if [[ ! -d "$ROOT/node_modules" || ! -d "$ROOT/apps/cloudflare/node_modules" ]]; then
    (cd "$ROOT" && pnpm install)
  fi
}

ensure_dev_vars() {
  local path="$ROOT/apps/cloudflare/.dev.vars"
  if [[ -f "$path" ]]; then
    return 0
  fi
  local key
  key="$(python3 -c 'import os,base64; print(base64.b64encode(os.urandom(32)).decode())')"
  umask 077
  cat >"$path" <<EOF
PAYLOAD_MASTER_KEY=${key}
CANARY_WEBHOOK_SECRET=dev-canary-not-for-production
WAITLIST_RATE_LIMIT_SECRET=dev-waitlist-not-for-production
EOF
  printf 'Wrote local %s (not used as production payload key).\n' "$path"
  if [[ -n "$REMOTE_TARGET" ]]; then
    printf 'Warning: --remote destination secrets will not decrypt until PAYLOAD_MASTER_KEY in .dev.vars matches the remote Worker secret.\n' >&2
  fi
}

apply_local_migrations() {
  [[ -z "$REMOTE_TARGET" ]] || return 0
  (
    cd "$ROOT/apps/cloudflare"
    CI=1 CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" pnpm exec wrangler d1 migrations apply eventforge-control-preview --local --persist-to "$STATE_DIR/wrangler-state"
    CI=1 CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" pnpm exec wrangler d1 migrations apply eventforge-events-preview --local --persist-to "$STATE_DIR/wrangler-state"
  )
}

write_remote_wrangler() {
  [[ "$REMOTE_TARGET" != "production" ]] || die "Production bindings cannot be used with development authentication. Use the deployed production API."
  python3 - "$ROOT/apps/cloudflare/wrangler.jsonc" "$ROOT/apps/cloudflare/wrangler.dev.remote.jsonc" "$REMOTE_TARGET" "$PUBLIC_ORIGIN" <<'PY'
import json, re, sys
src, dest, target, origin = sys.argv[1:5]
text = open(src, encoding="utf-8").read()
text = re.sub(r"^\s*//.*$", "", text, flags=re.M)
text = re.sub(r",\s*(?=[}\]])", "", text)
cfg = json.loads(text)
prod = (cfg.get("env") or {}).get("production") or {}
cfg.pop("env", None)
if target == "production":
    for key in ("d1_databases", "r2_buckets"):
        if key in prod:
            cfg[key] = prod[key]
vars_ = cfg.setdefault("vars", {})
vars_["ENVIRONMENT"] = "development"
vars_["AUTH_CONSOLE_ORIGIN"] = origin
vars_["AUTH_CAPTCHA_DISABLED"] = "true"
cfg.pop("send_email", None)
for row in cfg.get("d1_databases") or []:
    row["remote"] = True
for row in cfg.get("r2_buckets") or []:
    row["remote"] = True
open(dest, "w", encoding="utf-8").write(json.dumps(cfg, indent=2) + "\n")
PY
}

tunnel_id() {
  "$CLOUDFLARED_BIN" tunnel list 2>/dev/null | awk -v name="$TUNNEL_NAME" '$2 == name { print $1; exit }'
}

ensure_tunnel() {
  need_cmd "$CLOUDFLARED_BIN"
  [[ -f "$HOME/.cloudflared/cert.pem" ]] || die "cloudflared is not logged in. Run: cloudflared tunnel login"
  local id
  id="$(tunnel_id || true)"
  if [[ -z "$id" ]]; then
    "$CLOUDFLARED_BIN" tunnel create "$TUNNEL_NAME" >/dev/null
    id="$(tunnel_id)"
    [[ -n "$id" ]] || die "Failed to create tunnel $TUNNEL_NAME"
  fi
  local cred="$HOME/.cloudflared/${id}.json"
  [[ -f "$cred" ]] || die "Missing tunnel credentials at $cred"
  cat >"$STATE_DIR/cloudflared.yml" <<EOF
tunnel: ${id}
credentials-file: ${cred}
ingress:
  - hostname: ${PUBLIC_HOST}
    service: ${CONSOLE_ORIGIN}
  - service: http_status:404
EOF
  local route_out=""
  set +e
  route_out="$("$CLOUDFLARED_BIN" tunnel route dns "$TUNNEL_NAME" "$PUBLIC_HOST" 2>&1)"
  local route_status=$?
  set -e
  if [[ $route_status -ne 0 ]]; then
    if ! grep -qiE 'already exists|CNAME record with that host already exists' <<<"$route_out"; then
      printf '%s\n' "$route_out" >&2
      die "Could not route ${PUBLIC_HOST} to ${TUNNEL_NAME}"
    fi
  fi
}

start_api() {
  local args=(
    pnpm exec wrangler dev
    --ip 127.0.0.1
    --port "$API_PORT"
    --inspector-port 9230
    --show-interactive-dev-session false
    --persist-to "$STATE_DIR/wrangler-state"
    --var "AUTH_CONSOLE_ORIGIN:${PUBLIC_ORIGIN}"
  )
  if [[ -n "$REMOTE_TARGET" ]]; then
    write_remote_wrangler
    args+=(-c wrangler.dev.remote.jsonc)
  fi
  start_logged api "$ROOT/apps/cloudflare" env CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" "${args[@]}"
}

start_control() {
  start_logged control "$ROOT/apps/control-plane" pnpm exec tsx watch src/index.ts
}

start_console() {
  start_logged console "$ROOT/apps/console" env \
    EVENTFORGE_PUBLIC_ORIGIN="$PUBLIC_ORIGIN" \
    EVENTFORGE_API_ORIGIN="$API_ORIGIN" \
    pnpm exec vite --host 127.0.0.1 --port "$CONSOLE_PORT" --strictPort
}

start_tunnel() {
  start_logged tunnel "$ROOT" "$CLOUDFLARED_BIN" tunnel --no-autoupdate --config "$STATE_DIR/cloudflared.yml" run
}

start_stack() {
  mkdirs
  need_cmd pnpm
  need_cmd curl
  need_cmd python3
  ensure_install
  ensure_dev_vars
  apply_local_migrations
  ensure_tunnel
  if [[ "$REMOTE_TARGET" == "production" ]]; then
    printf 'Warning: --remote=production uses live production D1/R2. Writes persist.\n' >&2
  fi
  start_api
  wait_http "$API_ORIGIN/health" "API worker" || {
    stop_stack
    die "API worker failed to start"
  }
  start_control
  if ! wait_http "$CONTROL_ORIGIN/health" "control plane" 20; then
    printf 'dev.sh: control plane is optional for Destinations; continuing without it.\n' >&2
    rm -f "$(pid_file control)"
  fi
  start_console
  wait_http "$CONSOLE_ORIGIN/" "console" || {
    stop_stack
    die "console failed to start"
  }
  # Always run the named tunnel. Local getaddrinfo can fail while the public
  # CNAME already points at Cloudflare; cloudflared dials out and does not
  # need the hostname to resolve on this machine.
  start_tunnel
  if ! wait_public; then
    printf 'dev.sh: %s is not answering yet; loopback remains %s\n' "$PUBLIC_ORIGIN" "$CONSOLE_ORIGIN/" >&2
  fi
  if ! python3 -c "import socket,sys; socket.getaddrinfo(sys.argv[1],443)" "$PUBLIC_HOST" 2>/dev/null; then
    printf 'dev.sh: this machine still NXDOMAINs %s (flush mDNSResponder / Tailscale cache). curl --resolve and browsers with a host-resolver rule still work.\n' "$PUBLIC_HOST" >&2
  fi
  print_status
}

stop_stack() {
  mkdirs
  local name
  for name in tunnel console control api; do
    local pid=""
    pid="$(read_pid "$name" 2>/dev/null || true)"
    if [[ -n "$pid" ]]; then
      stop_tree "$pid"
    fi
    rm -f "$(pid_file "$name")"
  done
  printf 'Stopped EventForge local stack.\n'
}

service_health() {
  local name="$1"
  case "$name" in
    api) curl -fsS -o /dev/null --max-time 2 "$API_ORIGIN/health" ;;
    control) curl -fsS -o /dev/null --max-time 2 "$CONTROL_ORIGIN/health" ;;
    console) curl -fsS -o /dev/null --max-time 2 "$CONSOLE_ORIGIN/" ;;
    tunnel)
      local ip
      ip="$(public_a_record)"
      if [[ -n "$ip" ]]; then
        curl -fsS -o /dev/null --max-time 5 --resolve "${PUBLIC_HOST}:443:${ip}" "$PUBLIC_ORIGIN/"
      else
        curl -fsS -o /dev/null --max-time 5 "$PUBLIC_ORIGIN/"
      fi
      ;;
    *) return 1 ;;
  esac
}

print_status() {
  printf '%-10s %-8s %-8s %s\n' "SERVICE" "PID" "HEALTH" "URL"
  local name pid health
  for name in "${services[@]}"; do
    pid="$(read_pid "$name" 2>/dev/null || true)"
    if is_pid_alive "${pid:-}"; then
      if service_health "$name"; then health="ok"; else health="down"; fi
    else
      pid="-"
      health="stopped"
    fi
    local url=""
    case "$name" in
      api) url="$API_ORIGIN/health" ;;
      control) url="$CONTROL_ORIGIN/health" ;;
      console) url="$CONSOLE_ORIGIN/" ;;
      tunnel) url="$PUBLIC_ORIGIN/" ;;
    esac
    printf '%-10s %-8s %-8s %s\n' "$name" "$pid" "$health" "$url"
  done
  if [[ -n "$REMOTE_TARGET" ]]; then
    printf 'data: remote %s D1/R2 (Worker still local)\n' "$REMOTE_TARGET"
  else
    printf 'data: local D1/R2\n'
  fi
}

follow_logs() {
  mkdirs
  local name="${1:-all}"
  if [[ "$name" == "all" ]]; then
    tail -n 50 -F "$LOG_DIR"/api.log "$LOG_DIR"/control.log "$LOG_DIR"/console.log "$LOG_DIR"/tunnel.log
  else
    [[ -f "$(log_file "$name")" ]] || die "No log for $name"
    tail -n 100 -F "$(log_file "$name")"
  fi
}

supervise() {
  trap 'printf "\nStopping…\n"; stop_stack; exit 0' INT TERM
  printf 'Supervising. Ctrl-C stops the stack.\n'
  while true; do
    local name pid
    for name in "${services[@]}"; do
      pid="$(read_pid "$name" 2>/dev/null || true)"
      if ! is_pid_alive "${pid:-}"; then
        printf '%s exited. Stopping remaining services.\n' "$name" >&2
        stop_stack
        exit 1
      fi
    done
    sleep 2
  done
}

parse_args "$@"
FOLLOW_LOGS_NAME="${FOLLOW_LOGS_NAME:-all}"

case "$COMMAND" in
  up | start)
    start_stack
    if [[ "$COMMAND" == "up" ]]; then
      supervise
    fi
    ;;
  stop | down)
    stop_stack
    ;;
  restart)
    stop_stack
    start_stack
    ;;
  status)
    mkdirs
    print_status
    ;;
  logs)
    follow_logs "$FOLLOW_LOGS_NAME"
    ;;
  *)
    die "Unknown command: $COMMAND"
    ;;
esac
