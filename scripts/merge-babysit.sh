#!/usr/bin/env bash
# Merge the open PRs, one at a time, in an order that actually works.
#
#   scripts/merge-babysit.sh            # dry run: the plan, no merges
#   scripts/merge-babysit.sh --yes      # merge what the policy allows
#
# Merging here is serial, and not because branch protection says so -- it does
# not. It is serial because every push to the default branch publishes
# shanehaynes.com within the minute. There is no staging step between this
# script and a live page under Shane's name, so the loop merges one thing,
# waits to see the site is still whole, brings the other branches up to date,
# and only then merges the next.
#
# Bringing branches up to date is `git merge origin/<default>`, never a rebase.
# These branches are pushed and another session may have one checked out; a
# rebase rewrites history under them and their next push either fails or
# clobbers. A merge commit is ugly and safe, and this repo allows merge
# commits, so the ugliness costs nothing.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

APPLY=0
MAX_ROUNDS=${PORTFOLIO_MERGE_ROUNDS:-10}
CI_WAIT=${PORTFOLIO_CI_WAIT:-600}

case "${1:-}" in
  --yes) APPLY=1 ;;
  ""|--dry-run) ;;
  -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "usage: scripts/merge-babysit.sh [--yes]" ;;
esac

command -v gh >/dev/null 2>&1 || die "gh is required"
PRIMARY=$(primary_dir)
DEFAULT=$(default_branch)
cd "$PRIMARY"

require_not_halted

[ "$APPLY" = 1 ] || note "${C_BOLD}dry run${C_OFF} ${C_DIM}(scripts/merge-babysit.sh --yes to merge)${C_OFF}"

round=0
merged_total=0
while [ "$round" -lt "$MAX_ROUNDS" ]; do
  round=$((round + 1))

  # Re-read the kill switch every round. A halt placed while the loop is
  # running has to stop the loop that is running, not the next one.
  require_not_halted

  git fetch --quiet --prune origin || die "fetch failed"

  prs=$(gh pr list --state open --json number --jq '.[].number' 2>/dev/null | tr '\n' ' ')
  set -- $prs
  if [ "$#" = 0 ]; then
    note ""
    note "${C_DIM}no open PRs.${C_OFF}"
    break
  fi

  note ""
  note "${C_BOLD}round $round${C_OFF}  ${C_DIM}$# open PR(s)${C_OFF}"

  mergeable_pr=""
  for n in "$@"; do
    # One call, capturing stdout and the exit code separately. An earlier
    # version used `$(node ... || echo '{}')`, which appended {} to the JSON
    # the failing call had already printed and made every HOLD read as "no
    # verdict" -- the policy was right and the reporting was lying about it.
    set +e
    verdict=$(node "$PRIMARY/scripts/merge-policy.mjs" --json "$n" 2>/dev/null)
    set -e

    summary=$(printf '%s' "$verdict" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const j = JSON.parse(s);
          // Fail closed on a shape we did not expect, same as the policy.
          const allow = j.allow === true;
          console.log(allow + "\t" + ((j.reasons || ["no reasons given"]).join("; ")));
        } catch {
          console.log("false\tno verdict (unparseable policy output) -- failing closed");
        }
      });
    ')
    allow=${summary%%	*}
    reason=${summary#*	}
    title=$(gh pr view "$n" --json title --jq .title 2>/dev/null || echo '?')

    if [ "$allow" = "true" ]; then
      printf '  %-8s #%-4s %s\n' "${C_GREEN}MERGE${C_OFF}" "$n" "$title"
      [ -z "$mergeable_pr" ] && mergeable_pr="$n"
    else
      printf '  %-8s #%-4s %s\n' "${C_YELLOW}hold${C_OFF}" "$n" "$title"
      printf '            %s%s%s\n' "$C_DIM" "$reason" "$C_OFF"
    fi
  done

  if [ -z "$mergeable_pr" ]; then
    note ""
    note "${C_DIM}nothing the policy allows this round.${C_OFF}"
    break
  fi

  if [ "$APPLY" = 0 ]; then
    note ""
    note "${C_DIM}dry run: would merge #$mergeable_pr, then bring the rest up to date and re-check.${C_OFF}"
    break
  fi

  # --- merge one --------------------------------------------------------------
  note ""
  note "merging #$mergeable_pr ..."
  gh pr merge "$mergeable_pr" --merge --delete-branch=false || die "merge of #$mergeable_pr failed"
  merged_total=$((merged_total + 1))
  git fetch --quiet origin

  # --- bring every remaining branch up to date --------------------------------
  # This is the step that makes the loop necessary: every merge invalidates
  # every other open PR's mergeability, and the next policy call has to see the
  # new answer, not the old one.
  rest=$(gh pr list --state open --json number,headRefName,baseRefName \
          --jq '.[] | select(.baseRefName=="'"$DEFAULT"'") | .headRefName' 2>/dev/null || true)
  for br in $rest; do
    note "  bringing $br up to date (merge, not rebase)"
    # The name is flattened in babysit_tmp_dir, not here, and every call that
    # takes the path ends its options with -- first. See lib/common.sh.
    tmp=$(babysit_tmp_dir "$br")
    rm -rf -- "$tmp"
    if git worktree add --quiet -- "$tmp" "$br" 2>/dev/null || git worktree add --quiet --track -b "$br" -- "$tmp" "origin/$br" 2>/dev/null; then
      if git -C "$tmp" merge --no-edit "origin/$DEFAULT" >/dev/null 2>&1; then
        git -C "$tmp" push --quiet origin "HEAD:$br" || warn "    push failed for $br"
      else
        git -C "$tmp" merge --abort 2>/dev/null || true
        warn "    ${C_YELLOW}$br conflicts with origin/$DEFAULT -- a human has to resolve it${C_OFF}"
      fi
      git worktree remove -- "$tmp" 2>/dev/null || { rm -rf -- "$tmp"; git worktree prune; }
    else
      warn "    could not check out $br"
    fi
  done

  # --- wait for the checks the merges just invalidated ------------------------
  waited=0
  while [ "$waited" -lt "$CI_WAIT" ]; do
    pending=0
    for n in $(gh pr list --state open --json number --jq '.[].number' 2>/dev/null); do
      st=$(gh pr view "$n" --json statusCheckRollup \
            --jq '[.statusCheckRollup[]?.state, .statusCheckRollup[]?.conclusion] | map(select(.)) | join(",")' 2>/dev/null || echo "")
      case "$st" in *PENDING*|*IN_PROGRESS*|*QUEUED*) pending=1 ;; esac
    done
    [ "$pending" = 0 ] && break
    note "  ${C_DIM}checks running... (${waited}s)${C_OFF}"
    sleep 20
    waited=$((waited + 20))
  done
done

note ""
if [ "$APPLY" = 1 ]; then
  note "merged $merged_total PR(s) in $round round(s)."
else
  note "${C_DIM}dry run -- nothing merged.${C_OFF}"
fi
note ""
note "${C_DIM}Kill switch: create $(halt_file) to stop this loop, including one already running.${C_OFF}"
