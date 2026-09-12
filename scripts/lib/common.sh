# Shared helpers. Sourced, never executed.
#
# Kept bash-3.2-clean (no associative arrays, no mapfile, no ${x^^}) so these
# scripts behave the same on the macOS system bash as on Linux.
#
# Every path in this repo can contain a space -- the checkout is literally
# named "Portfolio Web App". Quote every expansion. An unquoted $PRIMARY is a
# bug that only shows up on this machine.

set -euo pipefail

PROJ_ENV_PREFIX="PORTFOLIO"

die() { printf '%s\n' "$*" >&2; exit 1; }
warn() { printf '%s\n' "$*" >&2; }
note() { printf '%s\n' "$*"; }

if [ -t 1 ]; then
  C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_OFF=$'\033[0m'
else
  C_DIM=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_OFF=''
fi

# Where this library lives: <checkout>/scripts/lib/common.sh -> <checkout>.
#
# Every path question below is answered relative to THIS, not to $PWD. That
# distinction is not academic. These scripts take destructive actions --
# git-tidy.sh removes worktrees and deletes branches -- and resolving the repo
# from the current directory means invoking a script by absolute path operates
# on whatever repo the shell happens to be standing in, silently and with no
# error. It did exactly that here once: a test harness ran this repo's
# git-tidy.sh --yes intending to act on a throwaway clone, with $PWD still in
# the live repo, and removed a running session's worktree.
#
# Each worktree has its own copy of scripts/, so anchoring here means a script
# always acts on the checkout it was run FROM, which is the only unambiguous
# reading of "this checkout".
ANCHOR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# The caller's directory, kept for scripts that take a relative path argument,
# and then we move. Sourcing this library relocates you to the checkout the
# script lives in, so that every bare `git` below -- in this file and in every
# script that sources it -- talks to that checkout and not to wherever the
# shell was standing. Anchoring only primary_dir() was not enough: the bare
# `git diff` in media-drift.sh still followed $PWD.
CALLER_PWD="$PWD"
cd "$ANCHOR"

# Resolve a path argument the way the caller meant it, not the way it reads
# from $ANCHOR.
caller_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$CALLER_PWD" "$1" ;;
  esac
}

# The primary checkout -- the one with a real .git directory.
#
# Anchored on --git-common-dir, never --show-toplevel: inside a linked worktree
# --show-toplevel returns the *worktree*, and a git-new.sh that trusted it
# would nest a worktree inside a worktree. --git-common-dir returns a relative
# ".git" from the primary and an absolute path from a worktree, so normalise.
primary_dir() {
  local common
  common=$(git -C "$ANCHOR" rev-parse --git-common-dir) || die "not inside a git repository: $ANCHOR"
  case "$common" in
    /*) ;;
    *) common="$ANCHOR/$common" ;;
  esac
  (cd "$common/.." && pwd)
}

# This checkout's root, whichever kind it is.
checkout_dir() { git -C "$ANCHOR" rev-parse --show-toplevel; }

# The one test used everywhere: .git is a directory here, a file in a worktree.
is_primary() { [ -d "$(checkout_dir)/.git" ]; }

state_dir() {
  local d
  d="$(primary_dir)/.claude/state"
  mkdir -p "$d"
  printf '%s\n' "$d"
}

claims_file() { printf '%s\n' "$(state_dir)/claims.tsv"; }
halt_file()   { printf '%s\n' "$(state_dir)/HALT"; }
worktrees_dir() { printf '%s\n' "$(primary_dir)/.claude/worktrees"; }

# Resolve the default branch from the remote rather than assuming "main", but
# do not let a missing origin/HEAD stop the world.
default_branch() {
  local ref
  if ref=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null); then
    printf '%s\n' "${ref#refs/remotes/origin/}"
    return
  fi
  if git show-ref --verify --quiet refs/remotes/origin/main; then
    printf '%s\n' main
  elif git show-ref --verify --quiet refs/remotes/origin/master; then
    printf '%s\n' master
  else
    printf '%s\n' main
  fi
}

# Dirty means anything git would not carry forward for free -- untracked files
# included. The favicons that collided in this repo were untracked, and a tidy
# that ignored them would have deleted a session's only copy of its work.
is_dirty() { [ -n "$(git -C "$1" status --porcelain 2>/dev/null)" ]; }

# Is a live process standing in this directory?
#
# "Merged and clean" says nothing about whether somebody is working there. A
# session whose worktree is deleted out from under it loses no commits and
# still cannot run another command. Prints the occupying pids, empty if none.
#
# Fails SAFE: if it cannot tell (no /proc, no lsof), it says "occupied" rather
# than "free", because the cost of keeping a dead worktree one more day is
# nothing and the cost of the other mistake is someone's afternoon.
# Has any commit ever been made on this branch?
#
# The obvious test -- does the tip equal origin/<default> -- cannot tell these
# two apart, and they are opposites:
#
#   a session that cut a branch five minutes ago and has not committed yet
#   a session whose commits fast-forwarded into the default branch
#
# and it stops protecting the first one the moment anybody else pushes, because
# then the tip no longer equals the new default tip.
#
# The branch's own reflog answers it exactly: a branch created by `git worktree
# add -b` has one entry, "branch: Created from ...", and nothing else until
# somebody commits on it. Reflogs expire at 90 days by default, so fall back to
# the tip comparison when there is no reflog to read -- a 90-day-old branch is
# not the "just started" case this is protecting.
has_own_commits() {
  local branch="$1" base_sha="$2" log n
  log=$(git reflog show "$branch" 2>/dev/null) || log=""
  if [ -z "$log" ]; then
    [ "$(git rev-parse "$branch")" != "$base_sha" ]
    return
  fi
  n=$(printf '%s\n' "$log" | grep -cE ':[[:space:]]*(commit|merge|cherry-pick|rebase|am|revert|reset)' || true)
  [ "${n:-0}" -gt 0 ]
}

occupants() {
  local path="$1"
  if [ -d /proc ]; then
    local pid cwd
    for pid in /proc/[0-9]*; do
      cwd=$(readlink "$pid/cwd" 2>/dev/null) || continue
      # A process whose cwd was removed reads as "<path> (deleted)" and keeps
      # holding the old inode. That still counts -- more than counts: it is
      # proof the directory was already pulled out from under someone.
      cwd="${cwd% (deleted)}"
      case "$cwd" in
        "$path"|"$path"/*) printf '%s ' "${pid#/proc/}" ;;
      esac
    done
  elif command -v lsof >/dev/null 2>&1; then
    lsof -a -d cwd -F pn 2>/dev/null | awk -v p="$path" '
      /^p/ { pid = substr($0,2) }
      /^n/ { d = substr($0,2); if (d == p || index(d, p "/") == 1) print pid }
    ' | sort -u | tr '\n' ' '
  else
    printf 'unknown '
  fi
}

port_for() {
  node "$(primary_dir)/dev/port.mjs" 2>/dev/null || printf '%s\n' '?'
}

require_not_halted() {
  local h
  h="$(halt_file)"
  if [ -e "$h" ]; then
    warn "${C_RED}HALT${C_OFF}  $h exists -- automation is stopped."
    [ -s "$h" ] && warn "      $(head -1 "$h")"
    warn "      Remove the file to resume."
    exit 3
  fi
}
