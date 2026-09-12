#!/usr/bin/env bash
# Cut a new worktree for one task.
#
#   scripts/git-new.sh <type>/<slug> ["what you will touch"] [--no-install]
#
# The primary checkout stays on the default branch, clean, forever. It is for
# reading and for owning shared state -- the media pipeline, the lock, the
# claims file. Nothing is built or committed there.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

PREFIXES="feat fix chore copy media infra"

usage() {
  cat >&2 <<USAGE
usage: scripts/git-new.sh <type>/<slug> ["what you will touch"] [--no-install]

  type    one of: $PREFIXES
            feat   new capability on the site
            fix    a defect a visitor could see
            chore  tooling, config, housekeeping
            copy   prose changes (content/*.md and the pages that render it)
            media  anything touching media/, images/ or the generation
                   pipeline -- these serialise on the media lock
            infra  this automation itself; most of these files are HELD by
                   merge-policy.mjs and need a human to merge

  intent  free text, recorded in the claims registry so the next session can
          see what you are about to touch before it starts editing the same
          lines. Optional, and omitting it is how collisions happen.

  --no-install  skip worktree bootstrap (.env.agents link, .media-work/).
USAGE
  exit 2
}

branch=""; intent=""; do_install=1
for arg in "$@"; do
  case "$arg" in
    --no-install) do_install=0 ;;
    -h|--help) usage ;;
    -*) die "unknown flag: $arg" ;;
    *) if [ -z "$branch" ]; then branch="$arg"; elif [ -z "$intent" ]; then intent="$arg"; else die "unexpected argument: $arg"; fi ;;
  esac
done
[ -n "$branch" ] || usage

# --- validate the branch name -------------------------------------------------
case "$branch" in
  */*) ;;
  *) die "branch must be <type>/<slug>; got '$branch'" ;;
esac
type="${branch%%/*}"
slug="${branch#*/}"
[ -n "$slug" ] || die "branch must be <type>/<slug>; got '$branch'"

ok=0
for p in $PREFIXES; do [ "$type" = "$p" ] && ok=1; done
[ "$ok" = 1 ] || die "branch type '$type' is not one of: $PREFIXES
The prefix set is not decoration -- merge-policy.mjs and the supervisor report
both read it. Pick the closest one rather than inventing a new prefix."

case "$slug" in
  *[!a-zA-Z0-9/._-]*) die "slug '$slug' has characters outside [a-zA-Z0-9._/-]" ;;
esac

PRIMARY=$(primary_dir)
WT_ROOT="$PRIMARY/.claude/worktrees"
# One directory per branch, '/' flattened to '-'. Two branches that flattened
# to the same directory would share a checkout; refuse rather than collide.
dirname_for_branch=$(printf '%s' "$branch" | tr '/' '-')
WT="$WT_ROOT/$dirname_for_branch"

# --- refuse anything that already exists --------------------------------------
if git -C "$PRIMARY" show-ref --verify --quiet "refs/heads/$branch"; then
  die "branch '$branch' already exists.
Another session may be on it right now. Pick a different slug, or if it is
yours and finished, retire it with scripts/git-tidy.sh."
fi
if git -C "$PRIMARY" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  die "origin/$branch already exists. Pick a different slug."
fi
[ -e "$WT" ] && die "$WT already exists. Remove it or pick a different slug."

# --- always branch from origin/<default>, never from here ---------------------
# A session that has been sitting in a stale checkout for two hours must not be
# able to make that staleness the base of new work. The fetch is not optional.
DEFAULT=$(default_branch)
note "${C_DIM}fetching origin...${C_OFF}"
git -C "$PRIMARY" fetch --quiet origin || die "fetch failed; fix the network before cutting a branch off a stale base"
base="origin/$DEFAULT"
git -C "$PRIMARY" rev-parse --verify --quiet "$base" >/dev/null || die "$base does not exist"
base_sha=$(git -C "$PRIMARY" rev-parse --short "$base")

mkdir -p "$WT_ROOT"
git -C "$PRIMARY" worktree add --quiet -b "$branch" "$WT" "$base"

# --- bootstrap ----------------------------------------------------------------
# There are no dependencies to install in a repo with no build step, but a
# worktree is still not usable out of the box: .env.agents and .media-work/ are
# gitignored, so a fresh worktree has neither, and any media command dies on a
# missing FAL_KEY. Symlink rather than copy -- one key, one place, and
# revoking it in the primary revokes it everywhere.
if [ "$do_install" = 1 ]; then
  if [ -f "$PRIMARY/.env.agents" ] && [ ! -e "$WT/.env.agents" ]; then
    ln -s "$PRIMARY/.env.agents" "$WT/.env.agents"
  fi
  mkdir -p "$WT/.media-work"
fi

# --- record the claim ---------------------------------------------------------
# Tabs are the field separator, so they cannot survive inside a field.
clean_intent=$(printf '%s' "$intent" | tr '\t\n' '  ')
CLAIMS=$(claims_file)
printf '%s\t%s\t%s\t%s\n' \
  "$branch" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$WT" "$clean_intent" >> "$CLAIMS"

# --- report -------------------------------------------------------------------
port=$(cd "$WT" && node "$PRIMARY/dev/port.mjs")

note ""
note "${C_GREEN}${C_BOLD}$branch${C_OFF}  from $base @ $base_sha"
note "  path  $WT"
note "  port  $port   ${C_DIM}scripts/serve.sh${C_OFF}"
[ "$do_install" = 1 ] || note "  ${C_YELLOW}bootstrap skipped${C_OFF} -- no .env.agents link, no .media-work/"
note ""
note "  cd \"$WT\""
note ""

if [ "$type" = "media" ]; then
  note "${C_YELLOW}media branch${C_OFF}: the pipeline is single-holder. Wrap every generation,"
  note "  re-encode or .media-work/ write in scripts/with-media-lock.sh."
  lockdir="$(state_dir)/locks/media.lock"
  if [ -d "$lockdir" ] && [ -f "$lockdir/meta" ]; then
    note "  ${C_RED}held right now:${C_OFF}"
    sed 's/^/    /' "$lockdir/meta"
  fi
  note ""
fi

if [ "$type" = "infra" ]; then
  note "${C_YELLOW}infra branch${C_OFF}: most of these paths are HELD by merge-policy.mjs."
  note "  Expect the merge loop to skip this PR and ask Shane for the merge-ok label."
  note ""
fi

# Every other live claim. Cheapest moment to notice an overlap is now, before a
# line is written -- two branches editing adjacent lines each merge cleanly
# into the default branch and then conflict with each other.
others=$(grep -v -F "	$WT	" "$CLAIMS" 2>/dev/null | awk -F'\t' -v self="$branch" '$1 != self' || true)
if [ -n "$others" ]; then
  note "${C_BOLD}Other claims${C_OFF} ${C_DIM}(a hint, not a lock -- a worktree made by hand claims nothing)${C_OFF}"
  printf '%s\n' "$others" | while IFS=$'\t' read -r b ts path it; do
    [ -d "$path" ] || continue
    printf '  %-34s %s\n' "$b" "${it:-${C_DIM}(no intent declared)${C_OFF}}"
  done
  note ""
  note "${C_DIM}If one of those names a file you are about to touch, coordinate or wait.${C_OFF}"
else
  note "${C_DIM}No other live claims.${C_OFF}"
fi
