// node --test scripts/hooks/
//
// decide() is pure, so it is tested directly rather than through the hook
// wrapper. The filesystem is the one impure input and it is injected: these
// tests never touch a real checkout, so they say the same thing on a machine
// where this repo is not present.
//
// The tests that matter most are the ALLOW cases. A guard that blocks
// everything passes every block test and makes the repo unusable, and the way
// that shows up in practice is a session inventing a subshell to get around it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, literalCdTargets, splitLeadingAssignments } from "./bash-guard.mjs";

const PRIMARY = "/home/u/Portfolio Web App";
const WORKTREE = "/home/u/Portfolio Web App/.claude/worktrees/feat-x";

// `.git` is a directory at PRIMARY, a file at WORKTREE, absent elsewhere.
const fakeFs = {
  statSync(p) {
    if (p === `${PRIMARY}/.git`) return { isDirectory: () => true };
    if (p === `${WORKTREE}/.git`) return { isDirectory: () => false };
    throw new Error("ENOENT");
  },
};

const at = (cwd, command) => decide({ command, cwd, fsImpl: fakeFs });
const blocked = (cwd, command) => {
  const m = at(cwd, command);
  assert.ok(m, `expected a block for: ${command}`);
  return m;
};
const allowed = (cwd, command) => {
  const m = at(cwd, command);
  assert.equal(m, null, `expected allow, got block for: ${command}\n${m}`);
};

// --- parsing helpers ---------------------------------------------------------

test("literalCdTargets reads quoted, unquoted and chained cd", () => {
  assert.deepEqual(literalCdTargets('cd "/a b/c" && git commit'), ["/a b/c"]);
  assert.deepEqual(literalCdTargets("cd /tmp; ls"), ["/tmp"]);
  assert.deepEqual(literalCdTargets("ls && cd '/x y' && pwd"), ["/x y"]);
  assert.deepEqual(literalCdTargets("cd /a && cd /b"), ["/a", "/b"]);
});

test("literalCdTargets skips unexpanded variables rather than guessing", () => {
  assert.deepEqual(literalCdTargets('cd "$PRIMARY" && git commit'), []);
  assert.deepEqual(literalCdTargets("cd $HOME/repo"), []);
  assert.deepEqual(literalCdTargets("cd `pwd`"), []);
});

test("splitLeadingAssignments peels env prefixes", () => {
  const { assignments, rest } = splitLeadingAssignments("FOO=1 BAR=2 git status");
  assert.deepEqual(assignments, ["FOO=1", "BAR=2"]);
  assert.equal(rest, "git status");
});

// --- 1. pkill / killall ------------------------------------------------------

test("blocks pkill on shared process names, and names the alternative", () => {
  for (const c of [
    "pkill -f http.server",
    "killall python3",
    "pkill node",
    "pkill -f 'python3 -m http.server'",
  ]) {
    const m = blocked(WORKTREE, c);
    assert.match(m, /lsof -i :\$\(scripts\/port\.sh\)/, `no alternative offered for: ${c}`);
  }
});

test("allows killing one pid, which is the sanctioned way", () => {
  allowed(WORKTREE, "kill 12345");
  allowed(WORKTREE, "kill -9 12345");
  allowed(WORKTREE, "lsof -i :5902");
});

// --- 2. destructive git ------------------------------------------------------

test("blocks destructive git", () => {
  for (const c of [
    "git reset --hard",
    "git reset --hard origin/main",
    "git clean -fd",
    "git clean -fdx",
    "git checkout -- .",
    "git checkout .",
    "git restore .",
    "git push --force origin feat/x",
    "git push -f origin feat/x",
    "git branch -D feat/x",
    "git worktree remove --force /some/path",
    "git worktree prune",
  ]) {
    blocked(WORKTREE, c);
  }
});

test("the override works, and is what the message tells you to type", () => {
  const m = blocked(WORKTREE, "git reset --hard");
  assert.match(m, /PORTFOLIO_DESTRUCTIVE_OK=1/);
  allowed(WORKTREE, "PORTFOLIO_DESTRUCTIVE_OK=1 git reset --hard");
  allowed(WORKTREE, "PORTFOLIO_DESTRUCTIVE_OK=1 git clean -fd");
  allowed(WORKTREE, "PORTFOLIO_DESTRUCTIVE_OK=1 git push --force origin feat/x");
});

test("a different env prefix is not the override", () => {
  blocked(WORKTREE, "PORTFOLIO_DESTRUCTIVE_OK=0 git reset --hard");
  blocked(WORKTREE, "SOMETHING_ELSE=1 git reset --hard");
});

test("--force-with-lease is not --force", () => {
  allowed(WORKTREE, "git push --force-with-lease origin feat/x");
});

test("non-destructive git is untouched", () => {
  for (const c of [
    "git status",
    "git reset HEAD~1",
    "git reset --soft HEAD~1",
    "git checkout -b feat/x",
    "git checkout main",
    "git restore --staged index.html",
    "git clean -n",
    "git branch -d feat/x",
    "git push origin feat/x",
    "git worktree remove /some/path",
  ]) {
    allowed(WORKTREE, c);
  }
});

// --- 3. the primary checkout -------------------------------------------------

test("blocks committing and building in the primary checkout", () => {
  for (const c of ["git commit -m x", "git add -A", "git merge origin/main", "git rebase origin/main", "ffmpeg -i a.png b.mp4"]) {
    const m = blocked(PRIMARY, c);
    assert.match(m, /scripts\/git-new\.sh/, `no alternative offered for: ${c}`);
  }
});

test("the same commands are fine in a worktree", () => {
  for (const c of ["git commit -m x", "git add -A", "git merge origin/main", "ffmpeg -i a.png b.mp4"]) {
    allowed(WORKTREE, c);
  }
});

test("catches a literal cd back into the primary checkout", () => {
  blocked(WORKTREE, `cd "${PRIMARY}" && git commit -m x`);
  blocked(WORKTREE, `cd "${PRIMARY}" && ffmpeg -i a.png b.mp4`);
});

test("an unexpanded cd target is not guessed at", () => {
  allowed(WORKTREE, 'cd "$PRIMARY" && git commit -m x');
});

test("reading in the primary checkout is the whole point of the primary checkout", () => {
  for (const c of ["git status", "git log --oneline -5", "cat index.html", "git worktree list", "scripts/supervisor-report.sh"]) {
    allowed(PRIMARY, c);
  }
});

test("git merge --abort in the primary is a recovery, not a build", () => {
  allowed(PRIMARY, "git merge --abort");
});

test("read-only plumbing that merely starts with a blocked verb is allowed", () => {
  // \b matches at a hyphen, so an earlier version of this guard blocked
  // `git merge-base` as `git merge` and stopped a repair mid-incident.
  // merge-base answers a question; commit-tree writes an unreferenced object;
  // combine-check.sh needs both, in the primary checkout.
  for (const c of [
    "git merge-base --is-ancestor 012fb9f origin/main",
    "git merge-tree --write-tree origin/a origin/b",
    "git commit-tree abc123 -p def456 -m x",
    "git checkout-index -a",
  ]) {
    allowed(PRIMARY, c);
  }
});

// --- 4. direct merges --------------------------------------------------------

test("blocks direct merge commands and the API path under them", () => {
  for (const c of [
    "gh pr merge 6 --squash",
    "gh pr merge --auto 6",
    "gh api -X PUT repos/shanehaynes/ShanePortfolio/pulls/6/merge",
    "gh api -X POST repos/shanehaynes/ShanePortfolio/merges -f base=main",
  ]) {
    const m = blocked(WORKTREE, c);
    assert.match(m, /merge-babysit\.sh/, `no alternative offered for: ${c}`);
  }
});

test("reading PR state is allowed", () => {
  allowed(WORKTREE, "gh pr list");
  allowed(WORKTREE, "gh pr view 6 --json mergeStateStatus");
  allowed(WORKTREE, "gh pr checks 6");
});

// --- 5. the authority boundary -----------------------------------------------

test("the agent cannot grant itself the merge-ok exception", () => {
  blocked(WORKTREE, "gh pr edit 6 --add-label merge-ok");
  blocked(WORKTREE, 'gh api repos/o/r/issues/6/labels -f "labels[]=merge-ok"');
});

test("other labels are not the exception token", () => {
  allowed(WORKTREE, "gh pr edit 6 --add-label needs-review");
  allowed(WORKTREE, "gh pr view 6 --json labels");
});

// --- 6. the key --------------------------------------------------------------

test("blocks staging .env.agents however it is spelled", () => {
  blocked(WORKTREE, "git add .env.agents");
  blocked(WORKTREE, "git add -f .env.agents");
  blocked(PRIMARY, "git add -A -f .env.agents");
});

// --- 7. hand-rolled preview servers ------------------------------------------

test("blocks a hand-started http.server and names the port script", () => {
  for (const c of ["python3 -m http.server", "python3 -m http.server 8000", "python -m http.server 5902"]) {
    const m = blocked(WORKTREE, c);
    assert.match(m, /scripts\/serve\.sh/, `no alternative offered for: ${c}`);
  }
});

test("the sanctioned server is allowed", () => {
  allowed(WORKTREE, "scripts/serve.sh");
  allowed(WORKTREE, "scripts/serve.sh --bg");
  allowed(WORKTREE, "scripts/port.sh");
});

// --- 8. the photographs ------------------------------------------------------

test("blocks image_gen aimed at a photograph", () => {
  const m = blocked(WORKTREE, 'codex exec "use image_gen to extend images/books.jpeg"');
  assert.match(m, /re-encode/i);
  blocked(WORKTREE, 'codex exec "image_gen: retouch the zion still"');
});

test("does not block the generated hero, nor plain re-encodes", () => {
  allowed(WORKTREE, 'codex exec "use image_gen for a new hero poster frame"');
  allowed(WORKTREE, "ffmpeg -i images/books.jpeg -vf scale=1600:-1 media/books-1600.jpg");
  allowed(WORKTREE, "scripts/with-media-lock.sh ffmpeg -i images/zion.jpeg media/zion-2400.avif");
});

// --- shape -------------------------------------------------------------------

test("empty and whitespace commands are allowed", () => {
  allowed(WORKTREE, "");
  allowed(WORKTREE, "   ");
});

test("a cwd outside any checkout classifies as not-primary and does not throw", () => {
  allowed("/var/tmp", "git commit -m x");
});

test("every block message names an alternative or an override", () => {
  const samples = [
    [WORKTREE, "pkill -f http.server"],
    [WORKTREE, "git reset --hard"],
    [PRIMARY, "git commit -m x"],
    [WORKTREE, "gh pr merge 6"],
    [WORKTREE, "gh pr edit 6 --add-label merge-ok"],
    [WORKTREE, "git add .env.agents"],
    [WORKTREE, "python3 -m http.server"],
    [WORKTREE, 'codex exec "image_gen images/books.jpeg"'],
  ];
  for (const [cwd, c] of samples) {
    const m = blocked(cwd, c);
    assert.match(
      m,
      /(scripts\/|PORTFOLIO_DESTRUCTIVE_OK=1|ask for the label|Nothing else should ever touch)/,
      `block message offers no way forward for: ${c}\n${m}`,
    );
  }
});
