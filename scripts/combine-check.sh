#!/usr/bin/env bash
# Do these branches combine?
#
#   scripts/combine-check.sh                      # pairwise over every open PR
#   scripts/combine-check.sh branch-a branch-b    # just these
#   scripts/combine-check.sh --check              # also build the fold and run the gate
#
# Each branch merges cleanly into the default branch on its own -- that is what
# a green PR means, and it is not the question. The question is whether they
# merge cleanly into the default branch *after each other*, and nothing in a
# per-PR check ever asks it. Two branches editing adjacent lines are both green
# and conflict the moment the first one lands.
#
# --check goes further. A clean textual merge can still fail: one branch adds a
# reference, another renames the file it points at, and git has no opinion
# because they touched different lines of different files. Folding the branches
# into a throwaway commit and running the real gate against it is the only
# check that sees that before the last PR merges.
#
# On a conflict: move one hunk. Do not stack the PRs. Stacking only retargets B
# to the default branch if A's branch is deleted in the right order, and this
# repo does not auto-delete head branches -- get that wrong and B merges into
# A's branch instead of main. Put the new line on the far side of an unchanged
# line and both merges stay trivial.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

DEEP=0
BRANCHES=""
for arg in "$@"; do
  case "$arg" in
    --check) DEEP=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown flag: $arg" ;;
    *) BRANCHES="$BRANCHES $arg" ;;
  esac
done

PRIMARY=$(primary_dir)
DEFAULT=$(default_branch)
cd "$PRIMARY"

note "${C_DIM}fetching origin...${C_OFF}"
git fetch --quiet --prune origin || die "fetch failed"

# --- what to compare ----------------------------------------------------------
if [ -z "$BRANCHES" ]; then
  if command -v gh >/dev/null 2>&1; then
    BRANCHES=$(gh pr list --state open --json headRefName --jq '.[].headRefName' 2>/dev/null | tr '\n' ' ' || true)
  fi
fi
BRANCHES=$(printf '%s' "$BRANCHES" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')

set -- $BRANCHES
if [ "$#" -lt 2 ]; then
  note "${C_DIM}$# open branch(es) -- nothing to combine.${C_OFF}"
  [ "$#" = 1 ] && note "${C_DIM}($1 merges into origin/$DEFAULT on its own; that is what CI says.)${C_OFF}"
  exit 0
fi

# Resolve each to a ref that exists, preferring the remote copy.
resolve_ref() {
  if git rev-parse --verify --quiet "origin/$1" >/dev/null; then printf 'origin/%s\n' "$1"
  elif git rev-parse --verify --quiet "$1" >/dev/null; then printf '%s\n' "$1"
  else printf '\n'; fi
}

note ""
note "${C_BOLD}pairwise merge-tree${C_OFF}  ${C_DIM}($# branches, against each other, not against origin/$DEFAULT)${C_OFF}"
conflicts=0
pairs=0
for a in "$@"; do
  for b in "$@"; do
    # Each unordered pair once.
    [ "$a" \< "$b" ] || continue
    ra=$(resolve_ref "$a"); rb=$(resolve_ref "$b")
    if [ -z "$ra" ] || [ -z "$rb" ]; then
      printf '  %-8s %s + %s  (branch not found)\n' "${C_YELLOW}skip${C_OFF}" "$a" "$b"
      continue
    fi
    pairs=$((pairs + 1))
    if out=$(git merge-tree --write-tree --name-only "$ra" "$rb" 2>&1); then
      tree=$(printf '%s' "$out" | head -1)
      printf '  %-8s %s + %s  %stree %s%s\n' "${C_GREEN}clean${C_OFF}" "$a" "$b" "$C_DIM" "${tree:0:12}" "$C_OFF"
    else
      conflicts=$((conflicts + 1))
      printf '  %-8s %s + %s\n' "${C_RED}CONFLICT${C_OFF}" "$a" "$b"
      # merge-tree prints the tree, then the conflicted paths, then an
      # informational block. The paths are what a human needs.
      printf '%s\n' "$out" | sed -n '2,$p' | sed '/^$/,$d' | sed 's/^/            /'
      printf '            %smove one hunk to the far side of an unchanged line; do not stack.%s\n' "$C_DIM" "$C_OFF"
    fi
  done
done

# --- the semantic fold --------------------------------------------------------
if [ "$DEEP" = 1 ]; then
  note ""
  note "${C_BOLD}--check: folding all branches and running the gate${C_OFF}"
  if [ "$conflicts" -gt 0 ]; then
    note "  ${C_YELLOW}skipped${C_OFF} -- resolve the textual conflicts above first."
  else
    base="origin/$DEFAULT"
    acc=$(git rev-parse "$base")
    ok=1
    for b in "$@"; do
      rb=$(resolve_ref "$b"); [ -n "$rb" ] || continue
      if ! tree=$(git merge-tree --write-tree "$acc" "$rb" 2>&1 | head -1); then
        note "  ${C_RED}CONFLICT${C_OFF} folding $b onto the accumulated tree"
        ok=0; break
      fi
      acc=$(git commit-tree "$tree" -p "$acc" -p "$rb" -m "combine-check: fold $b")
    done

    if [ "$ok" = 1 ]; then
      TMPWT="$PRIMARY/.claude/worktrees/.combine-check-$$"
      cleanup_wt() {
        [ -d "$TMPWT" ] || return 0
        git -C "$PRIMARY" worktree remove "$TMPWT" 2>/dev/null \
          || { rm -rf "$TMPWT"; git -C "$PRIMARY" worktree prune; }
      }
      trap cleanup_wt EXIT
      git worktree add --quiet --detach "$TMPWT" "$acc"

      # Bootstrap the throwaway the same way git-new.sh bootstraps a real one,
      # so the gate sees the same tree a session would.
      [ -f "$PRIMARY/.env.agents" ] && ln -sf "$PRIMARY/.env.agents" "$TMPWT/.env.agents"
      mkdir -p "$TMPWT/.media-work"

      note "  ${C_DIM}folded $# branches onto $base -> ${acc:0:12}${C_OFF}"
      note ""
      if bash "$PRIMARY/scripts/check.sh" "$TMPWT"; then
        note ""
        note "  ${C_GREEN}the fold builds and passes the gate${C_OFF}"
      else
        conflicts=$((conflicts + 1))
        note ""
        note "  ${C_RED}the fold is textually clean and still fails the gate.${C_OFF}"
        note "  ${C_DIM}This is the failure no per-PR check can see. Fix it before the last PR merges.${C_OFF}"
      fi
      cleanup_wt
      trap - EXIT
    else
      conflicts=$((conflicts + 1))
    fi
  fi
fi

note ""
if [ "$conflicts" = 0 ]; then
  note "${C_GREEN}$pairs pair(s) combine cleanly.${C_OFF}"
  exit 0
fi
note "${C_RED}$conflicts problem(s).${C_OFF} Fix before opening or merging these together."
exit 1
