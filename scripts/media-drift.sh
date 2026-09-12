#!/usr/bin/env bash
# Is this checkout's media source material the same as what is published?
#
#   scripts/media-drift.sh [--quiet]
#
# The pipeline under .media-work/ is shared and holds the state of whatever ran
# last, which is not necessarily built from what is on the default branch. This
# is the one command that answers "am I about to re-encode from a stale base".
# --quiet prints only the drift lines and nothing when clean, so a caller can
# test for output.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

DEFAULT=$(default_branch)
git fetch --quiet origin 2>/dev/null || true

out=""
if ! git rev-parse --verify --quiet "origin/$DEFAULT" >/dev/null; then
  out="origin/$DEFAULT is unavailable -- cannot judge drift"
else
  changed=$(git diff --name-only "origin/$DEFAULT" -- media images 2>/dev/null || true)
  behind=$(git rev-list --count "HEAD..origin/$DEFAULT" 2>/dev/null || echo 0)
  [ "$behind" -gt 0 ] && out="behind origin/$DEFAULT by $behind commit(s)"
  if [ -n "$changed" ]; then
    n=$(printf '%s\n' "$changed" | wc -l | tr -d ' ')
    out="${out:+$out
}$n media/images path(s) differ from origin/$DEFAULT:
$(printf '%s\n' "$changed" | head -10 | sed 's/^/  /')"
  fi
fi

if [ "$QUIET" = 1 ]; then
  [ -n "$out" ] && printf '%s\n' "$out"
  exit 0
fi

if [ -z "$out" ]; then
  note "${C_GREEN}clean${C_OFF} -- media/ and images/ match origin/$DEFAULT"
else
  note "${C_YELLOW}drift${C_OFF}"
  printf '%s\n' "$out" | sed 's/^/  /'
fi

work="$(primary_dir)/.media-work"
if [ -d "$work" ]; then
  note ""
  note "${C_BOLD}shared pipeline${C_OFF}  $work"
  note "  size        $(du -sh "$work" 2>/dev/null | cut -f1)"
  newest=$(find "$work" -type f -newer "$work/.." -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || true)
  [ -n "${newest:-}" ] && note "  last write  $(date -r "$newest" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '?')  $(basename "$newest")"
  note "  ${C_DIM}this holds the last run's state, not the default branch's.${C_OFF}"
fi
