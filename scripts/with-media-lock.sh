#!/usr/bin/env bash
# Serialise everything that touches the media pipeline.
#
#   scripts/with-media-lock.sh <command> [args...]
#
# Three singular resources sit behind one lock, because every job that touches
# one touches the others:
#
#   .media-work/   8.6 GB of hero-pipeline intermediates and a python venv,
#                  in the primary checkout. Two ffmpeg runs writing the same
#                  intermediate name produce a file that is neither.
#   FAL_KEY        one fal.ai account. Parallel video generations are billed
#                  in parallel, and their logs interleave into one file.
#   codex image_gen  one ChatGPT subscription, rate-limited per account.
#
# The primitive is mkdir, not flock: macOS ships no flock, and mkdir is atomic
# on every filesystem this will ever run on. The cost is that the kernel does
# not release a directory when its holder dies, so the holder's pid goes inside
# the lock and a contender may reap it only once that pid is provably gone.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

RESOURCE=media
WAIT_DEFAULT=600
POLL=2

[ $# -gt 0 ] || die "usage: scripts/with-media-lock.sh <command> [args...]"

# Re-entrancy. A wrapped script that reaches this wrapper again -- easy to do
# once encode steps start calling each other -- would otherwise queue behind
# itself and sit there until the timeout.
if [ "${PORTFOLIO_LOCKED:-}" = "1" ]; then
  exec "$@"
fi

require_not_halted

LOCK_ROOT="$(state_dir)/locks"
mkdir -p "$LOCK_ROOT"
LOCK="$LOCK_ROOT/$RESOURCE.lock"

WAIT=${PORTFOLIO_LOCK_WAIT:-$WAIT_DEFAULT}
case "$WAIT" in
  ''|*[!0-9]*) die "PORTFOLIO_LOCK_WAIT=$WAIT is not a number of seconds" ;;
esac

HELD_BY_US=0
release() {
  if [ "$HELD_BY_US" = 1 ] && [ -d "$LOCK" ]; then
    # Only ever remove a lock whose pid file still says it is ours. If we were
    # reaped as stale and someone else took it, that directory is theirs now.
    if [ "$(cat "$LOCK/pid" 2>/dev/null || echo '')" = "$$" ]; then
      rm -rf "$LOCK"
    fi
  fi
}
trap release EXIT INT TERM

describe_holder() {
  if [ -f "$LOCK/meta" ]; then
    sed 's/^/      /' "$LOCK/meta"
  else
    printf '      (no metadata yet -- holder is mid-acquire)\n'
  fi
}

acquire() {
  local waited=0 announced=0 dead_pid="" 
  while :; do
    if mkdir "$LOCK" 2>/dev/null; then
      HELD_BY_US=1
      printf '%s\n' "$$" > "$LOCK/pid"
      {
        printf 'pid       %s\n' "$$"
        printf 'branch    %s\n' "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
        printf 'worktree  %s\n' "$(checkout_dir 2>/dev/null || pwd)"
        printf 'since     %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        printf 'command   %s\n' "$*"
      } > "$LOCK/meta"
      return 0
    fi

    local holder
    holder=$(cat "$LOCK/pid" 2>/dev/null || echo "")

    if [ -z "$holder" ]; then
      # No pid file yet. This is a holder between mkdir and the write, not a
      # stale lock. Reaping here is how you get two holders.
      dead_pid=""
    elif kill -0 "$holder" 2>/dev/null; then
      dead_pid=""
    else
      # Pid is gone. Confirm across one poll before reaping, and require the
      # pid to be unchanged: if it changed, the lock was already released and
      # retaken while we looked.
      if [ "$dead_pid" = "$holder" ]; then
        warn "${C_YELLOW}reaping stale $RESOURCE lock${C_OFF} -- holder pid $holder is gone"
        rm -rf "$LOCK"
        dead_pid=""
        continue
      fi
      dead_pid="$holder"
    fi

    if [ "$announced" = 0 ]; then
      warn "${C_YELLOW}waiting for the $RESOURCE lock${C_OFF} (up to ${WAIT}s), held by:"
      describe_holder >&2
      announced=1
    fi

    if [ "$waited" -ge "$WAIT" ]; then
      warn ""
      warn "${C_RED}timed out after ${WAIT}s waiting for the $RESOURCE lock.${C_OFF}"
      warn "Holder:"
      describe_holder >&2
      warn ""
      warn "Raise the wait (PORTFOLIO_LOCK_WAIT=1800) or ask that session to finish."
      warn "Do not delete $LOCK by hand while that pid is alive."
      exit 75   # EX_TEMPFAIL: try again later, do not treat as a real failure
    fi
    sleep "$POLL"
    waited=$((waited + POLL))
  done
}

# --- drift, before handing the pipeline over ----------------------------------
# .media-work/ holds the state of the last run, not the state of the default
# branch. A session that re-encodes from a stale source commits an asset that
# does not match the page referencing it, and nothing catches that but eyes.
drift=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  drift=$(bash "$(dirname "${BASH_SOURCE[0]}")/media-drift.sh" --quiet 2>/dev/null || true)
fi
if [ -n "$drift" ]; then
  warn "${C_YELLOW}media sources differ from origin/$(default_branch):${C_OFF}"
  printf '%s\n' "$drift" | sed 's/^/      /' >&2
  if [ ! -t 0 ] && [ "${PORTFOLIO_MEDIA_STALE_OK:-}" != "1" ]; then
    warn ""
    warn "${C_RED}Refusing to run unattended against drifted media sources.${C_OFF}"
    warn "Rebase or merge origin/$(default_branch) first, or set"
    warn "PORTFOLIO_MEDIA_STALE_OK=1 if the drift is the change you are making."
    exit 4
  fi
fi

acquire "$@"
note "${C_GREEN}$RESOURCE lock acquired${C_OFF} ${C_DIM}(pid $$)${C_OFF}"

set +e
PORTFOLIO_LOCKED=1 "$@"
rc=$?
set -e
exit "$rc"
