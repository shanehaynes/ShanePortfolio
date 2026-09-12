#!/usr/bin/env bash
# The gate. Everything a worktree can verify about itself, hermetically.
#
#   scripts/check.sh [path]
#
# Hermetic on purpose: no port is bound, no lock is taken, no network is
# touched, nothing under .media-work/ is read. Two worktrees can run this at
# the same second and neither can see the other. That property is what lets
# combine-check.sh --check run it against a throwaway merge, and what lets
# fanned-out agents run it without coordinating.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

TARGET=$([ -n "${1:-}" ] && caller_path "$1" || checkout_dir)
PRIMARY=$(primary_dir)
rc=0

note "${C_BOLD}site${C_OFF}  $TARGET"
node "$PRIMARY/dev/site-checks.mjs" "$TARGET" || rc=1

note ""
note "${C_BOLD}tooling${C_OFF}"
if ls "$TARGET"/scripts/*.test.mjs "$TARGET"/scripts/hooks/*.test.mjs >/dev/null 2>&1; then
  if out=$(cd "$TARGET" && node --test scripts/*.test.mjs scripts/hooks/*.test.mjs 2>&1); then
    printf '  ok    unit tests (%s)\n' "$(printf '%s' "$out" | sed -n 's/^# pass \([0-9]*\)/\1/p')"
  else
    printf '  FAIL  unit tests\n'
    printf '%s\n' "$out" | sed -n '/^not ok/,/^  \.\.\./p' | sed 's/^/          /'
    rc=1
  fi
else
  printf '  %sskip  unit tests (none in this tree)%s\n' "$C_DIM" "$C_OFF"
fi

if [ -d "$TARGET/scripts" ]; then
  bad=""
  for s in "$TARGET"/scripts/*.sh "$TARGET"/scripts/lib/*.sh; do
    [ -f "$s" ] || continue
    bash -n "$s" 2>/dev/null || bad="$bad $(basename "$s")"
  done
  if [ -z "$bad" ]; then printf '  ok    shell syntax\n'; else printf '  FAIL  shell syntax:%s\n' "$bad"; rc=1; fi
fi

note ""
if [ "$rc" = 0 ]; then
  note "${C_GREEN}gate passed${C_OFF}"
else
  note "${C_RED}gate failed${C_OFF}"
fi
exit "$rc"
