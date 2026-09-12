#!/usr/bin/env bash
# Retire worktrees and branches whose work has landed.
#
#   scripts/git-tidy.sh          # dry run: say what would go
#   scripts/git-tidy.sh --yes    # actually remove
#
# The safety rules matter more than the function. Everything this script might
# delete could be the only copy of another session's work, and the sessions
# cannot see each other. When a rule and a cleanup disagree, the rule wins and
# the thing stays.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

APPLY=0
case "${1:-}" in
  --yes) APPLY=1 ;;
  ""|--dry-run) ;;
  -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "usage: scripts/git-tidy.sh [--yes]" ;;
esac

PRIMARY=$(primary_dir)
WT_ROOT="$PRIMARY/.claude/worktrees"
DEFAULT=$(default_branch)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

git -C "$PRIMARY" fetch --quiet origin || warn "${C_YELLOW}fetch failed -- judging against a possibly stale origin/$DEFAULT${C_OFF}"
BASE_SHA=$(git -C "$PRIMARY" rev-parse "origin/$DEFAULT")

[ "$APPLY" = 1 ] || note "${C_BOLD}dry run${C_OFF} ${C_DIM}(scripts/git-tidy.sh --yes to apply)${C_OFF}"
note ""

removed=0; kept=0

# --- worktrees ----------------------------------------------------------------
# `git worktree list --porcelain` is the only listing that sees worktrees
# outside the managed directory, which is exactly the set we must report and
# never touch.
while IFS= read -r line; do
  case "$line" in
    worktree\ *) wt_path="${line#worktree }" ;;
    branch\ *) wt_branch="${line#branch refs/heads/}" ;;
    locked*) wt_locked=1 ;;
    detached*) wt_branch="(detached)" ;;
    "")
      [ -n "${wt_path:-}" ] || continue
      keep=""

      # Rule 5: never the primary checkout.
      if [ "$wt_path" = "$PRIMARY" ]; then
        wt_path=""; wt_branch=""; wt_locked=""
        continue
      fi

      # Rule 3: outside the managed directory -- report, never remove. It
      # probably belongs to a running session that chose its own location.
      case "$wt_path" in
        "$WT_ROOT"/*) ;;
        *) keep="outside $WT_ROOT -- not managed here, left alone" ;;
      esac

      # Rule 1: uncommitted changes, merged or not. Untracked files count;
      # this repo has already had two sessions holding different untracked
      # favicons at once.
      if [ -z "$keep" ] && [ -d "$wt_path" ] && is_dirty "$wt_path"; then
        n=$(git -C "$wt_path" status --porcelain | wc -l | tr -d ' ')
        keep="$n uncommitted change(s)"
      fi

      # Rule 1b: somebody is standing in it.
      #
      # Merged and clean says nothing about whether a session is working there.
      # This rule exists because its absence caused a real incident here: a
      # merged, clean worktree was removed while a Claude session had it as its
      # working directory. No commits were lost and the session was still
      # broken -- every subsequent command in it failed on a directory that no
      # longer existed.
      if [ -z "$keep" ] && [ -d "$wt_path" ]; then
        occ=$(occupants "$wt_path")
        [ -n "$occ" ] && keep="occupied by pid(s) ${occ% } -- a session is working there"
      fi

      # Rule 5: never the branch this invocation is standing on.
      if [ -z "$keep" ] && [ "${wt_branch:-}" = "$CURRENT_BRANCH" ]; then
        keep="you are on this branch"
      fi

      if [ -z "$keep" ] && [ "${wt_branch:-}" != "(detached)" ] && [ -n "${wt_branch:-}" ]; then
        # Rule 2: no commits of its own. "Nothing to merge" and "nothing done
        # yet" are opposites that look identical by commit count, so ask the
        # branch's reflog whether a commit was ever made on it.
        if ! has_own_commits "$wt_branch" "$BASE_SHA"; then
          keep="no commits of its own yet -- a session that just started"
        # Rule 4: not fully contained in origin/<default>.
        elif ! git -C "$PRIMARY" merge-base --is-ancestor "$wt_branch" "origin/$DEFAULT" 2>/dev/null; then
          ahead=$(git -C "$PRIMARY" rev-list --count "origin/$DEFAULT..$wt_branch" 2>/dev/null || echo '?')
          keep="$ahead commit(s) not in origin/$DEFAULT"
        fi
      fi

      if [ -z "$keep" ] && [ "${wt_locked:-}" = 1 ]; then
        keep="git-locked worktree -- unlock it deliberately first"
      fi

      if [ -n "$keep" ]; then
        printf '  %-10s %-34s %s\n' "${C_YELLOW}keep${C_OFF}" "${wt_branch:-(detached)}" "$keep"
        kept=$((kept + 1))
      else
        printf '  %-10s %-34s %s\n' "${C_GREEN}remove${C_OFF}" "$wt_branch" "merged into origin/$DEFAULT, clean"
        if [ "$APPLY" = 1 ]; then
          git -C "$PRIMARY" worktree remove "$wt_path" \
            && git -C "$PRIMARY" branch -d "$wt_branch" >/dev/null \
            && removed=$((removed + 1))
        fi
      fi
      wt_path=""; wt_branch=""; wt_locked=""
      ;;
  esac
done < <(git -C "$PRIMARY" worktree list --porcelain; echo "")

# --- branches with no worktree ------------------------------------------------
note ""
note "${C_BOLD}branches with no worktree${C_OFF}"
while IFS= read -r b; do
  [ "$b" = "$DEFAULT" ] && continue
  [ "$b" = "$CURRENT_BRANCH" ] && { printf '  %-10s %-34s %s\n' "${C_YELLOW}keep${C_OFF}" "$b" "current branch"; continue; }
  git -C "$PRIMARY" worktree list --porcelain | grep -qx "branch refs/heads/$b" && continue
  if ! has_own_commits "$b" "$BASE_SHA"; then
    printf '  %-10s %-34s %s\n' "${C_YELLOW}keep${C_OFF}" "$b" "no commits of its own yet"
  elif git -C "$PRIMARY" merge-base --is-ancestor "$b" "origin/$DEFAULT"; then
    printf '  %-10s %-34s %s\n' "${C_GREEN}remove${C_OFF}" "$b" "merged into origin/$DEFAULT"
    [ "$APPLY" = 1 ] && git -C "$PRIMARY" branch -d "$b" >/dev/null && removed=$((removed + 1))
  else
    ahead=$(git -C "$PRIMARY" rev-list --count "origin/$DEFAULT..$b")
    extra=""
    # A squash-merged branch is not an ancestor of the default branch even
    # though its content landed. git cherry marks such commits '-'. Report it;
    # deleting it is still a human's call, because the same shape appears when
    # someone rebased and force-pushed over unmerged work.
    if [ -n "$(git -C "$PRIMARY" cherry "origin/$DEFAULT" "$b" 2>/dev/null | grep '^+' || true)" ]; then
      extra=""
    else
      extra=" ${C_DIM}(content appears already applied -- squash-merged? delete by hand)${C_OFF}"
    fi
    printf '  %-10s %-34s %s\n' "${C_YELLOW}keep${C_OFF}" "$b" "$ahead commit(s) not in origin/$DEFAULT$extra"
  fi
done < <(git -C "$PRIMARY" for-each-ref --format='%(refname:short)' refs/heads)

# --- prune dead claims --------------------------------------------------------
# Rule 6. A claim whose worktree is gone is noise that makes the live claims
# harder to read, which is the only thing the registry is for.
CLAIMS=$(claims_file)
if [ -f "$CLAIMS" ]; then
  note ""
  note "${C_BOLD}claims${C_OFF}"
  tmp=$(mktemp)
  dead=0
  while IFS=$'\t' read -r b ts path it; do
    [ -n "${b:-}" ] || continue
    if [ -d "${path:-}" ]; then
      printf '%s\t%s\t%s\t%s\n' "$b" "$ts" "$path" "$it" >> "$tmp"
    else
      printf '  %-10s %-34s %s\n' "${C_GREEN}prune${C_OFF}" "$b" "worktree gone"
      dead=$((dead + 1))
    fi
  done < "$CLAIMS"
  if [ "$dead" = 0 ]; then
    note "  ${C_DIM}nothing to prune${C_OFF}"
  elif [ "$APPLY" = 1 ]; then
    mv "$tmp" "$CLAIMS"
  fi
  [ -f "$tmp" ] && rm -f "$tmp"
fi

note ""
if [ "$APPLY" = 1 ]; then
  note "removed $removed, kept $kept"
else
  note "${C_DIM}dry run -- nothing changed. $kept item(s) protected by a rule above.${C_OFF}"
fi
