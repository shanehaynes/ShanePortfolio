#!/usr/bin/env bash
# One read-only pass over everything that rots between sessions.
#
#   scripts/supervisor-report.sh
#
# Mutates nothing. The only write it makes is `git fetch`, which updates
# remote-tracking refs and touches no branch, no worktree and no file -- and
# without it every judgement below would be made against a stale origin.
#
# Lines that need a human or a decision are prefixed ACTION. Everything else is
# just the state of the world.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

PRIMARY=$(primary_dir)
DEFAULT=$(default_branch)
cd "$PRIMARY"

act() { printf '%sACTION%s  %s\n' "$C_RED" "$C_OFF" "$*"; }
info() { printf '        %s\n' "$*"; }
head2() { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_OFF"; }

printf '%sparallel-session report%s  %s\n' "$C_BOLD" "$C_OFF" "$(date '+%Y-%m-%d %H:%M')"
printf '%s%s%s\n' "$C_DIM" "$PRIMARY" "$C_OFF"

git fetch --quiet --prune origin 2>/dev/null || act "fetch failed -- everything below may be stale"

# --- the halt switch ----------------------------------------------------------
if [ -e "$(halt_file)" ]; then
  head2 "halt"
  act "automation is halted: $(halt_file)"
  info "$(head -1 "$(halt_file)" 2>/dev/null)"
fi

# --- the primary checkout -----------------------------------------------------
head2 "primary checkout"
pb=$(git rev-parse --abbrev-ref HEAD)
if [ "$pb" != "$DEFAULT" ]; then
  act "on '$pb', not $DEFAULT. The primary checkout is supposed to sit on the default branch."
  info "Anything cut from here inherits whatever state '$pb' is in."
else
  info "on $DEFAULT"
fi
dirty=$(git status --porcelain | wc -l | tr -d ' ')
if [ "$dirty" != 0 ]; then
  act "$dirty uncommitted change(s) in the primary checkout"
  git status --porcelain | head -8 | sed 's/^/        /'
  info "No other session can see these. They are not backed up by being on disk."
else
  info "clean"
fi
behind=$(git rev-list --count "HEAD..origin/$DEFAULT" 2>/dev/null || echo '?')
[ "$behind" != 0 ] && info "behind origin/$DEFAULT by $behind commit(s)"

# --- the default branch -------------------------------------------------------
head2 "origin/$DEFAULT"
info "$(git log -1 --format='%h  %s' "origin/$DEFAULT")"
info "$(git log -1 --format='%an, %ar' "origin/$DEFAULT")"
if command -v gh >/dev/null 2>&1; then
  runs=$(gh run list --branch "$DEFAULT" --limit 1 --json conclusion,displayTitle,status 2>/dev/null || echo '[]')
  concl=$(printf '%s' "$runs" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j[0]?((j[0].conclusion||j[0].status)+" :: "+j[0].displayTitle):"no runs")}catch{console.log("?")}})' 2>/dev/null || echo '?')
  case "$concl" in
    success*|SUCCESS*) info "pages build: $concl" ;;
    "no runs") info "no workflow runs (this repo has no CI beyond the Pages deploy)" ;;
    *) act "pages build: $concl" ;;
  esac
fi

# --- worktrees ----------------------------------------------------------------
head2 "worktrees"
WT_ROOT="$PRIMARY/.claude/worktrees"
now=$(date +%s)
while IFS= read -r line; do
  case "$line" in
    worktree\ *) wp="${line#worktree }" ;;
    branch\ *) wb="${line#branch refs/heads/}" ;;
    detached*) wb="(detached)" ;;
    "")
      [ -n "${wp:-}" ] || continue
      [ "$wp" = "$PRIMARY" ] && { wp=""; wb=""; continue; }
      label="${wb:-(detached)}"
      port=$(cd "$wp" 2>/dev/null && node "$PRIMARY/dev/port.mjs" 2>/dev/null || echo '?')
      d=""; is_dirty "$wp" 2>/dev/null && d="$(git -C "$wp" status --porcelain | wc -l | tr -d ' ') dirty"
      ahead=$(git rev-list --count "origin/$DEFAULT..$wb" 2>/dev/null || echo '?')
      last=$(git -C "$wp" log -1 --format=%ct 2>/dev/null || echo "$now")
      age_d=$(( (now - last) / 86400 ))

      case "$wp" in
        "$WT_ROOT"/*) where="" ;;
        *) where=" ${C_YELLOW}[outside the managed dir]${C_OFF}" ;;
      esac
      printf '        %-34s :%-5s %s%s\n' "$label" "$port" "${d:-clean}$( [ "$ahead" != 0 ] && printf ', %s ahead' "$ahead")" "$where"

      if [ "$age_d" -ge 7 ] && [ -n "$d" ]; then
        act "$label: ${age_d}d since its last commit and still dirty -- likely abandoned, but it holds uncommitted work"
      elif [ "$age_d" -ge 7 ]; then
        act "$label: ${age_d}d since its last commit -- likely abandoned"
      fi
      case "$wp" in
        "$WT_ROOT"/*) ;;
        *) act "$label lives outside $WT_ROOT. If that is /tmp it does not survive a reboot." ;;
      esac
      wp=""; wb=""
      ;;
  esac
done < <(git worktree list --porcelain; echo "")

# --- claims -------------------------------------------------------------------
head2 "claims"
CLAIMS=$(claims_file)
if [ ! -s "$CLAIMS" ]; then
  info "none filed"
else
  while IFS=$'\t' read -r b ts path it; do
    [ -n "${b:-}" ] || continue
    ct=$(date -d "$ts" +%s 2>/dev/null || echo "$now")
    age_d=$(( (now - ct) / 86400 ))
    if [ ! -d "${path:-}" ]; then
      act "claim '$b' points at a worktree that no longer exists -- scripts/git-tidy.sh --yes prunes it"
    elif [ "$age_d" -ge 7 ]; then
      act "claim '$b' is ${age_d}d old -- still intended?"
    else
      printf '        %-34s %s\n' "$b" "${it:-(no intent declared)}"
    fi
  done < "$CLAIMS"
fi
# A worktree with no claim is invisible to every other session's git-new.sh.
while IFS= read -r wb; do
  [ -n "$wb" ] || continue
  grep -q "^$wb	" "$CLAIMS" 2>/dev/null || act "worktree '$wb' has filed no claim -- other sessions cannot see what it is touching"
done < <(git worktree list --porcelain | sed -n 's/^branch refs\/heads\///p')

# --- the shared resource ------------------------------------------------------
head2 "media pipeline (the locked resource)"
LOCK="$(state_dir)/locks/media.lock"
if [ -d "$LOCK" ]; then
  hp=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$hp" ] && kill -0 "$hp" 2>/dev/null; then
    info "held right now:"
    sed 's/^/        /' "$LOCK/meta" 2>/dev/null
  else
    act "lock directory exists but pid ${hp:-<none>} is gone -- the next caller reaps it automatically"
  fi
else
  info "free"
fi
drift=$(bash "$PRIMARY/scripts/media-drift.sh" --quiet 2>/dev/null || true)
if [ -n "$drift" ]; then
  act "the primary checkout's media sources differ from origin/$DEFAULT:"
  printf '%s\n' "$drift" | sed 's/^/        /'
else
  info "media/ and images/ match origin/$DEFAULT"
fi
[ -d "$PRIMARY/.media-work" ] && info ".media-work: $(du -sh "$PRIMARY/.media-work" 2>/dev/null | cut -f1), holding the last run's state"

# --- ports --------------------------------------------------------------------
head2 "ports"
# Two questions, and the second is the one that matters.
#
#   1. Is anything listening on a port the resolver derived? Expected, fine.
#   2. Is anything listening that was *started from inside this repo* on a port
#      the resolver did not choose? That is a session that rolled its own
#      server, and nothing else in this system knows the number. The Bash guard
#      catches the common spelling of that mistake; it cannot catch a custom
#      script, so this is where one gets noticed.
if command -v lsof >/dev/null 2>&1; then
  # Collect every worktree path and its derived port. Paths go into a file
  # rather than a variable: they contain spaces, and one of them is in /tmp.
  wt_list=$(mktemp)
  git worktree list --porcelain | sed -n 's/^worktree //p' > "$wt_list"
  derived=""
  while IFS= read -r w; do
    p=$( (cd "$w" 2>/dev/null && node "$PRIMARY/dev/port.mjs" 2>/dev/null) || true)
    [ -n "$p" ] && derived="$derived $p"
  done < "$wt_list"
  derived="$derived 8000"

  found=0
  for p in $derived; do
    pid=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
    [ -n "${pid:-}" ] && { found=1; info "$p  bound by pid $pid  (derived -- expected)"; }
  done

  # Anything listening whose process is rooted in this repo but is not on a
  # derived port.
  if [ -d /proc ]; then
    for pid in $(lsof -nP -iTCP -sTCP:LISTEN -t 2>/dev/null | sort -u); do
      cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue
      # Match against every worktree, not just paths under the primary
      # checkout. A worktree in /tmp is outside $PRIMARY entirely, and it is
      # the likeliest place for an undeclared server to be running.
      rooted=0
      while IFS= read -r w; do
        case "$cwd" in "$w"|"$w"/*) rooted=1; break ;; esac
      done < "$wt_list"
      [ "$rooted" = 1 ] || continue
      p=$(lsof -nP -iTCP -sTCP:LISTEN -a -p "$pid" 2>/dev/null | awk 'NR==2{split($9,a,":");print a[length(a)]}')
      [ -n "${p:-}" ] || continue
      case " $derived " in
        *" $p "*) ;;
        *)
          found=1
          act "pid $pid is listening on $p, which no resolver chose"
          info "     started from ${cwd#$PRIMARY/}"
          info "     $(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-70)"
          info "     Nothing else in this system knows that number: not the claims"
          info "     file, not this report, not the session that opens it next."
          ;;
      esac
    done
  fi
  rm -f "$wt_list"
  [ "$found" = 0 ] && info "no preview server is listening"
else
  info "lsof unavailable -- cannot check"
fi

# --- open PRs -----------------------------------------------------------------
head2 "open PRs"
if command -v gh >/dev/null 2>&1; then
  nums=$(gh pr list --state open --json number --jq '.[].number' 2>/dev/null | tr '\n' ' ')
  if [ -z "$nums" ]; then
    info "none"
  else
    for n in $nums; do
      set +e
      v=$(node "$PRIMARY/scripts/merge-policy.mjs" --json "$n" 2>/dev/null)
      set -e
      line=$(printf '%s' "$v" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.verdict+"\t"+(j.reasons||[]).join("; ")+"\t"+(j.pr?j.pr.title:""))}catch{console.log("NO VERDICT\tpolicy output unreadable\t")}})')
      verdict=${line%%	*}; rest=${line#*	}; why=${rest%%	*}; title=${rest#*	}
      printf '        #%-4s %-11s %s\n' "$n" "$verdict" "$title"
      [ "$verdict" = "MERGE" ] || info "             $why"
    done
    info ""
    info "scripts/merge-babysit.sh shows the plan; --yes runs it."
  fi
else
  info "gh unavailable"
fi

# --- what tidy would do -------------------------------------------------------
head2 "what git-tidy.sh would clean"
tidy_out=$(bash "$PRIMARY/scripts/git-tidy.sh" 2>/dev/null | grep -E '^  (remove|prune) ' || true)
if [ -n "$tidy_out" ]; then
  printf '%s\n' "$tidy_out" | sed 's/^  /        /'
else
  info "nothing"
fi

printf '\n%sread-only: nothing above was changed.%s\n' "$C_DIM" "$C_OFF"
