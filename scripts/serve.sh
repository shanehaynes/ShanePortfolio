#!/usr/bin/env bash
# Preview this worktree on this worktree's port. The only sanctioned way to
# look at the site.
#
# strictPort semantics, by hand: python3 -m http.server exits non-zero on
# "Address already in use" rather than sliding to the next free port, and this
# script keeps it that way on purpose. A server that quietly moved to 5903
# would be a server nothing else can find -- the supervisor report, the claim
# line and the URL printed here would all name 5902, and the session would be
# reading a page that is not the one it is serving.
#
# Usage: scripts/serve.sh [--bg]
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

root=$(checkout_dir)
port=$(node "$(primary_dir)/dev/port.mjs" "$root")
label=$(basename "$root")
is_primary && kind="primary checkout" || kind="worktree $label"

# Fail before binding, with a message that names the holder, rather than
# letting python print a bare EADDRINUSE.
if command -v lsof >/dev/null 2>&1; then
  holder=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
  if [ -n "${holder:-}" ]; then
    warn "${C_RED}port $port is already bound${C_OFF} by pid $holder:"
    ps -o pid=,command= -p "$holder" 2>/dev/null | sed 's/^/      /' >&2 || true
    warn ""
    warn "If that is your own stale server, kill that pid and only that pid:"
    warn "      kill $holder"
    warn "Never pkill the server name -- every other session is running one too."
    exit 1
  fi
fi

note "${C_BOLD}$kind${C_OFF} -> ${C_GREEN}http://localhost:$port/${C_OFF}"
note "${C_DIM}serving $root${C_OFF}"

if [ "${1:-}" = "--bg" ]; then
  mkdir -p "$(state_dir)/logs"
  log="$(state_dir)/logs/serve-$label.log"
  ( cd "$root" && exec python3 -m http.server "$port" --bind 127.0.0.1 ) >"$log" 2>&1 &
  note "${C_DIM}pid $!, log $log${C_OFF}"
  exit 0
fi

cd "$root"
exec python3 -m http.server "$port" --bind 127.0.0.1
