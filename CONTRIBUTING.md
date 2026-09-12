# Working in this repo with several sessions at once

CLAUDE.md has the rules. This file has the reasons, one section per hazard, each stating the
failure mode before the rule. A rule with its reason attached survives contact with a session
that is in a hurry; a bare rule does not.

The governing idea is that every collision between parallel sessions is an unpartitioned
shared resource. So, in order of preference: **partition** anything derivable per workspace
(branches, working trees, ports); **lock** what is genuinely singular (the media pipeline);
**declare** what can be neither (intent to edit particular files); and make all three
mechanical, because a rule that lives only in a markdown file is a rule that gets broken at
2am by a session that skimmed it.

---

## 1. Sessions cannot see each other's work

**The failure.** Session A spends an hour on `index.html` and has not committed. Session B
opens the same file, sees the version on disk from `main`, and rewrites it. Both are correct
about what they saw. Neither `git status`, `git log`, nor the file itself gives either of
them any hint the other exists.

**Why it is not fixable by being careful.** Uncommitted work is invisible by construction.
There is no command B could have run that would have shown A's edits, because they are in a
different directory that B has no reason to look at.

**The rule.** One worktree per task, cut by `scripts/git-new.sh`, which records what you are
about to touch in a registry every other session reads before it starts. That registry is a
*hint*, not a lock — a worktree made by hand claims nothing, and a claim does not stop
anybody. It is the only thing that turns invisible work into visible intent, which is enough
in practice, because the expensive collisions are the ones nobody knew about.

If a claim names a file you were about to touch: coordinate or wait. Two branches editing
adjacent lines of one file each merge cleanly into `main` and then conflict with each
other — a conflict that only appears after the first one lands, to whoever is unlucky enough
to be second.

---

## 2. The primary checkout is shared state

**The failure.** A session commits in the primary checkout, leaves it on a feature branch,
and goes away. Every `scripts/git-new.sh` after that reads its branch and its working tree.
The next session's "clean branch from main" is not clean and is not from main.

**The rule.** The primary checkout stays on `main`, clean, forever. It is for reading and for
owning shared state: the claims file, the lock, the 8.6 GB media pipeline. A `PreToolUse`
hook blocks `git commit`, `git add`, `git merge`, `git rebase`, `ffmpeg` and `codex exec`
there, and extracts literal `cd` targets from the command so that changing directory into it
first is caught too.

Unexpanded variables are *not* guessed at. A command that changes into a directory named by
a shell variable is allowed through, because blocking on a maybe is how a guard earns a
reputation for crying wolf and gets routed around with a subshell. The guard catches the
ordinary mistake, not the deliberate one.

**Note for when this bites you:** `scripts/git-new.sh` always fetches and branches from
`origin/main`, never from whatever the current checkout is sitting on. A stale checkout must
not be able to become the base of new work.

---

## 3. A fixed port is a silent wrong answer

**The failure.** This is the worst failure mode in the whole system because it produces no
error at all. Two sessions preview on the same port. The second either fails to bind — fine,
you notice — or does not start a server, opens the port anyway, and sees a portfolio site.
It looks right. It is the other worktree's HTML. The session then reports that its change
works.

In a repo whose entire verification story is "look at it in a browser", that is a
verification system that returns the wrong answer and says nothing.

**The rule.** One resolver, `dev/port.mjs`, and every consumer imports it. Three consumers
that each compute a port are three consumers that can disagree.

```
PORTFOLIO_PORT           explicit override, validated; garbage throws rather than
                         falling through to a different-but-valid port
primary checkout         8000 -- python3 -m http.server's own default, so the number
                         a human types by reflex stays true where they type it
linked worktree          FNV-1a hash of the worktree directory name into 5200-5999
```

The hash only has to spread ~800 slots and give the same answer tomorrow, so that a
bookmarked tab keeps working. Primary vs linked is detected with the test used everywhere
else: `.git` is a directory in the primary checkout and a file in a linked worktree.

`scripts/serve.sh` fails loudly on a taken port rather than sliding to the next free one. A
server that quietly moved to 5903 is a server nothing else can find — the report, the claim
line and the printed URL would all still say 5902.

The hook blocks hand-started `http.server` invocations. It cannot block a custom script, so
`scripts/supervisor-report.sh` flags any listener rooted in a worktree on a port no resolver
chose. There was one when this was written: a session in a `/tmp` worktree serving on 8765,
a number nothing else in the system knew.

---

## 4. The media pipeline is singular

**The failure.** Two ffmpeg runs writing the same intermediate name produce a file that is
neither. Two fal.ai generations bill in parallel against one account and interleave their
logs into one file. `codex exec`'s `image_gen` is rate-limited per subscription.

**The rule.** `scripts/with-media-lock.sh <command>`, and every script that resets or seeds
`.media-work/` goes through it.

The primitive is an atomic `mkdir`, not `flock`, because macOS ships no `flock`. The cost of
`mkdir` is that the kernel does not release the directory when the holder dies, so:

- the holder's pid goes in a file *inside* the lock directory;
- a contender reaps the lock only when that pid is provably gone, and only after seeing the
  same dead pid twice, in case it was released and retaken while we looked;
- **a lock directory with no pid file yet is a holder mid-acquire, not a stale one.** Reaping
  that is how you get two holders.

Waiting is bounded (`PORTFOLIO_LOCK_WAIT`, default 600s — media runs are long, so queueing
is the right default) and exits 75 rather than hanging forever. `PORTFOLIO_LOCKED=1` is
exported so a wrapped command that reaches the wrapper again re-execs instead of deadlocking.

**`.media-work/` holds the state of the last run, not the state of `main`.** Check before you
build on it:

```
scripts/media-drift.sh
```

An unattended run against drifted sources refuses and says so rather than quietly producing
an asset that does not match the page referencing it. `PORTFOLIO_MEDIA_STALE_OK=1` overrides
it when the drift *is* the change you are making.

---

## 5. Cross-branch collisions that no per-PR check can see

**The failure, textual.** Two branches are both green. Each merges into `main` cleanly. The
first one lands and the second now conflicts — and the conflict surfaces to whoever is
second, at merge time, which is the worst moment to discover it.

**The failure, semantic.** Worse, because nothing reports it at all. One branch renames an
asset and updates every reference to it. Another branch adds a *new* reference to the old
name — perfectly valid on its own branch, where the file still exists. They touch different
files, so git merges both without a murmur, and the combination ships a broken image.

This repo has no numbered migrations, ADRs or fixture IDs, so it has no filename-ordered
global counter and there is no `next-*.sh` script. The collision class is real here anyway;
it just arrives through file renames and through new files added on two branches at once.

**The rule.**

```
scripts/combine-check.sh           # pairwise merge-tree over every open PR
scripts/combine-check.sh --check   # also fold them into a throwaway commit and run the gate
```

`--check` builds the fold with `git merge-tree --write-tree` + `git commit-tree`, checks it
out into a detached worktree, runs the real gate, and removes the worktree. It is the only
check that sees a clean textual merge that still does not work.

**On a conflict, move one hunk. Do not stack the PRs.** Stacking only retargets B to `main`
if A's branch is deleted in the right order, and this repo does not auto-delete head
branches. Get it wrong and B merges into A's branch instead of `main`, and the PR closes
looking successful. Put the new line on the far side of an unchanged line and both merges
stay trivial.

---

## 6. The guard, and why it fails open

**The failure it prevents.** `pkill -f http.server` kills every session's preview server, and
none of them is told why. A hard reset discards a working tree that may be another session's
only copy.

**The rule.** A `PreToolUse` hook on `Bash`. Exit 2 with a reason on stderr blocks; anything
else allows. It blocks kill-by-name, destructive git, building in the primary checkout,
direct merges, self-granted merge labels, staging `.env.agents`, hand-rolled servers, and
`image_gen` aimed at a photograph.

**Internal errors allow.** A guard that failed closed on an unexpected payload would block
every Bash call in every session at once, and the fix would have to be typed somewhere the
guard is not running. One missed block is recoverable; an unusable repo is not.

Three things learned the hard way:

- **Every block message names the alternative.** A block with no way forward gets papered
  over with a subshell within the hour, and then the guard is worse than nothing because
  everyone believes it is working.
- **The patterns match the whole command string**, so writing documentation that quotes a
  banned command trips the guard on the documentation. Use the file tools for those.
- **`\b` matches at a hyphen.** `/git\s+merge\b/` also matches `git merge-base`, and
  `/git\s+commit\b/` matches `git commit-tree` — both read-only plumbing that
  `scripts/combine-check.sh` needs. Blocking them stopped a repair mid-incident once. The
  patterns use `(?![-\w])` now, and there is a test.

The decision function is pure — `(command, cwd, projectDir) -> message | null` — and is
tested in `scripts/hooks/bash-guard.test.mjs`. The tests that matter most are the *allow*
cases: a guard that blocks everything passes every block test and makes the repo unusable.

The override exists on purpose. `PORTFOLIO_DESTRUCTIVE_OK=1` is not a loophole; the hook is
there to make you read `git status` first, not to stop you. It must lead the whole command,
not sit inside a loop.

---

## 7. Bounded authority

**The failure.** An unattended session merges a PR that edits the hook that constrains it,
or the policy that decides what it may merge, or `CNAME`. Self-amending authority is the one
bound that cannot survive contact with itself.

**The rule.** `scripts/merge-policy.mjs` holds a path list decided by **blast radius, not
style**. The question for each entry is: if this merges wrong, can it be undone by another
commit? If yes, it does not belong on the list. So `index.html` and `content/*.md` are *not*
held — a wrong word is revertible in a minute, and holding the ordinary work of the repo
would make the automation useless. Held instead:

| Path | If it merges wrong |
|---|---|
| `.claude/settings.json`, `scripts/`, `dev/` | the automation's own authority, and every script the settings allow-list runs unprompted |
| `_config.yml` | this repo's CI config in all but name. Drop `content` from its exclude list and the internal working copy publishes at shanehaynes.com/content/career.md — which has happened here once |
| `CNAME` | production routing for the apex domain; recovery is DNS-propagation slow |
| `.gitignore` | take `.env.agents` off it and the next `git add -A` commits `FAL_KEY` to a public repo. Rotating the key does not un-publish it |
| `package.json`, `Gemfile` | none exist; the hold is so a human reads the PR that introduces a supply chain to a repo that has none |
| `CLAUDE.md`, `CONTRIBUTING.md` | prose every future session reads as instructions |

The exception is a **repo-side label**, `merge-ok`: auditable, revocable, per-PR. The hook
blocks an agent from applying it to its own PR, because otherwise the boundary dissolves. A
review approval could not serve as the token — the automation acts as the repo owner, who
cannot approve their own PRs.

**The policy fails closed. The hook fails open.** That asymmetry is deliberate. The hook sits
in front of every command, so failing closed would brick every session at once. The policy
sits in front of publishing to a public site under Shane's name, where a merge that should
not have happened is live before anyone reads the log. There is no symmetric cost, so when
in doubt it does nothing and says why.

That includes not knowing. GitHub computes mergeability lazily and reports `UNKNOWN` while it
works; PR #6 here read `UNKNOWN` on one call and `CONFLICTING` on the next, seconds apart.
Unknown is not a yes.

**Kill switch:** `.claude/state/HALT`. Checked before every run and again each round, so a
halt placed mid-loop stops the loop that is running.

---

## 8. Retiring work without destroying it

**The failure.** Cleanup that deletes a branch someone is still using, or a worktree holding
uncommitted work, or a directory a live session is standing in.

**The rule.** `scripts/git-tidy.sh` is a dry run by default. Its safety rules, in order:

1. never touch a worktree with uncommitted changes, merged or not — untracked files count;
2. never remove a worktree a live process is standing in;
3. never remove a worktree whose branch has no commits of its own;
4. report but never remove a worktree outside the managed directory;
5. never delete a branch not fully contained in `origin/main`;
6. never touch the primary checkout or the current branch;
7. prune claim lines whose worktree is gone.

Two of those are subtler than they look.

**Rule 3 cannot be answered by comparing the tip to `origin/main`.** That test cannot tell a
session that cut a branch five minutes ago from one whose commits just fast-forwarded into
`main` — they look identical and mean opposite things — and it stops protecting the fresh
branch the moment anybody else pushes. The branch's own reflog answers it exactly: a branch
created by `git worktree add -b` has one entry and nothing else until somebody commits on it.

**Rule 2 was added after it was needed.** "Merged and clean" says nothing about whether
somebody is working there; see the incident below.

---

## 9. Fanning work out to several agents

When one session coordinates others, the division of labour is:

- **the coordinating session owns every shared resource.** It cuts the worktrees, it alone
  touches the media lock and the primary checkout, and it runs the cross-branch checks before
  the PRs open and the merge loop after;
- **agents run only per-worktree checks** — `scripts/check.sh`, and a preview on their own
  port. Those are hermetic: they bind nothing shared, take no lock, touch no network, and two
  can run in the same second without seeing each other;
- **agents commit and push their own branch and report the SHA.** The coordinator opens the
  PRs, because the coordinator is the one that can see all of them at once;
- **an agent refused a shared-resource action by its permission mode reports that.** It does
  not route around it. A refusal is information about the boundary, not an obstacle.

---

## The incident

Two of these, both real, both in this repo.

### The favicons

While the inventory for this work was being taken, two sessions had each independently
generated a favicon set. Both sets were untracked, so git reported no conflict of any kind —
not a merge conflict, not a warning, nothing in `git status` that looked unusual in either
session:

```
favicon.ico           primary 4286 B    other worktree 14510 B
favicon.svg           primary  286 B    other worktree   371 B
apple-touch-icon.png  primary  467 B    other worktree  4709 B
```

Whichever session committed first would have won. The second's `git add favicon.ico` would
have overwritten it with different bytes and reported success. Nobody would have chosen
between them, and nobody would have known there was a choice.

This is the shape the whole system is built around: **the expensive collisions are the ones
that produce no error.** It is why `git-new.sh` prints every other session's claim before you
write a line, and why `combine-check.sh` exists — an add/add of the same path *is* a real
merge conflict, so the check that would have caught this is the one that compares branches
against each other rather than each against `main`.

### The worktree deleted out from under a running session

Later the same evening, while testing `git-tidy.sh --yes`, the test harness invoked the
script by absolute path with the shell's working directory still in the live repo.
`primary_dir()` resolved the repo from `$PWD`, not from the script's own location. So a test
that believed it was operating on a throwaway clone ran `--yes` against the live repo and
removed a worktree that a Claude session was working in, along with a local branch.

Nothing was lost — the branch was fully contained in `origin/main` and the working tree was
clean, so restoring it was exact — but the session's directory was gone underneath it, and
every subsequent command in that session would have failed on a path that no longer existed.

Three fixes came out of it, and all three are in the code:

1. **`scripts/lib/common.sh` anchors on the script's own location and changes directory
   there at source time.** Anchoring only `primary_dir()` was not enough; the bare `git diff`
   in `media-drift.sh` still followed `$PWD`. A destructive script that resolves its target
   from the current directory is a loaded gun pointed at whatever you happen to be standing
   in.
2. **`git-tidy.sh` will not remove an occupied worktree.** Merged and clean is not the same
   as unattended. It reads `/proc` on Linux and `lsof -d cwd` on macOS, counts a `(deleted)`
   cwd as occupancy too, and fails *safe* — if it cannot tell, it keeps the worktree.
3. **The acceptance test now asserts the anchoring before it does anything destructive**, and
   deliberately runs with its working directory in the live repo. If the anchoring ever
   regresses, the test aborts instead of demonstrating the regression on real work.

### And the one still waiting to happen

`fix/scroll-seams` is checked out in a worktree under `/tmp`, with a preview server on port
8765. `/tmp` does not survive a reboot, no other session can find that directory, and 8765 is
a number nothing in this system knows about. The supervisor report flags both. That is the
next incident, already visible, and the reason `git-new.sh` puts worktrees in a repo-relative
directory and never in `/tmp`.
