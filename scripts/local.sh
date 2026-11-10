#!/usr/bin/env bash
# Run Grokbot on this computer (macOS or Linux).
#
#   ./scripts/local.sh            install if needed, build, start, and open the app
#   ./scripts/local.sh stop       stop the server (and the companion it started)
#   ./scripts/local.sh status     is it running?
#   ./scripts/local.sh logs       follow the server log
#
# First run creates .env with a fresh SESSION_SECRET and COMPUTER_PROVIDER=local.
# Add API keys in the app (Settings → API keys), then Settings → Computer → Use this computer.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
PIDFILE="$ROOT/data/grokbot.pid"
LOGFILE="$ROOT/data/logs/server.log"

envval() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//; s/[[:space:]]*$//' || true; }
PORT="${PORT:-$(envval PORT)}"
PORT="${PORT:-8787}"
URL="http://localhost:$PORT"

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

check_tools() {
  command -v node >/dev/null || { echo "Node.js 22+ is required: https://nodejs.org"; exit 1; }
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node.js 22+ is required (found $(node --version))."; exit 1; }
  command -v openssl >/dev/null || { echo "openssl is required."; exit 1; }
}

ensure_env() {
  [ -f .env ] && return
  cat > .env <<EOF
# Created by scripts/local.sh. Add API keys in the app: Settings → API keys.
OPENROUTER_API_KEY=
OPENROUTER_MODEL=x-ai/grok-4.7
XAI_API_KEY=
XAI_MODEL=grok-4.7
COMPOSIO_API_KEY=
COMPUTER_PROVIDER=local
PORT=$PORT
APP_URL=$URL
SERVER_URL=$URL
SESSION_SECRET=$(openssl rand -hex 32)
DEV_LOGIN=1
EOF
  echo "Created .env (keys go in the app: Settings → API keys)."
}

install_and_build() {
  if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    echo "Installing dependencies…"
    npm ci --no-audit --no-fund
  fi
  if [ ! -f server/dist/index.js ] || [ ! -f web/dist/index.html ] || [ -n "$(find server/src web/src -newer server/dist/index.js -print -quit 2>/dev/null)" ]; then
    echo "Building…"
    npm run build >/dev/null
  fi
}

start() {
  check_tools
  ensure_env
  install_and_build
  mkdir -p "$(dirname "$LOGFILE")"
  if running; then
    echo "Already running (pid $(cat "$PIDFILE"))."
  else
    if curl -sf "$URL/api/health" >/dev/null; then
      echo "Something else is already serving $URL. Stop it first (or set PORT)."; exit 1
    fi
    # cd first, then background only node, so $! is the server's own pid
    (cd server || exit 1; nohup node --env-file=../.env dist/index.js >> "$LOGFILE" 2>&1 & echo $! > "$PIDFILE")
    for _ in $(seq 1 40); do curl -sf "$URL/api/health" >/dev/null && break; running || break; sleep 0.5; done
  fi
  if ! running || ! curl -sf "$URL/api/health" >/dev/null; then
    rm -f "$PIDFILE"
    echo "The server didn't start. Last log lines:"; tail -20 "$LOGFILE"; exit 1
  fi
  echo
  echo "Grokbot is running at $URL"
  echo "  1. Sign in with any email (local dev sign-in)."
  echo "  2. Settings → API keys: paste your OpenRouter key (or xAI), then pick a model."
  echo "  3. Settings → Computer → Use this computer."
  echo "Stop it with ./scripts/local.sh stop · logs: ./scripts/local.sh logs"
  if [ "$(uname)" = "Darwin" ] && [ -z "${NO_OPEN:-}" ]; then open "$URL"; fi
}

stop() {
  if ! running; then rm -f "$PIDFILE"; echo "Not running."; return; fi
  local pid; pid="$(cat "$PIDFILE")"
  kill "$pid"
  # Wait for a clean exit (it stops the companion it started), then insist.
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  rm -f "$PIDFILE"
  echo "Stopped."
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
  status) if running; then echo "Running (pid $(cat "$PIDFILE")) at $URL"; curl -s "$URL/api/health"; echo; else echo "Not running."; fi ;;
  logs) tail -f "$LOGFILE" ;;
  *) echo "Usage: $0 [start|stop|restart|status|logs]"; exit 2 ;;
esac
