// node --test scripts/merge-babysit.test.mjs
//
// merge-babysit.sh cannot be sourced -- it merges PRs at the top level -- so
// the one pure piece of it, the path of the throwaway worktree it uses to
// bring a held branch up to date, lives in lib/common.sh where a test can call
// it. The rest of this file reads the script as text and checks that the loop
// actually uses that helper and never hands a bare path to rm or git worktree.
//
// The bug this guards against: the path was built and THEN every '/' in it was
// turned into '-', absolute directory included. The result began with '-',
// `rm -rf` read it as an option, and under set -e the loop died after the
// first merge with every other branch left stale (2026-09-14, after PR #22).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(here, "merge-babysit.sh"), "utf8");

// Run one line of bash with lib/common.sh sourced. $1.. are the extra args.
function sh(line, ...args) {
  return execFileSync("bash", ["-c", `. "$0/lib/common.sh" && ${line}`, here, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

test("a branch containing a slash yields a path under the primary's worktrees dir, not one beginning with '-'", () => {
  const primary = sh("primary_dir");
  assert.ok(primary.startsWith("/"), `primary_dir should be absolute, got ${primary}`);
  const root = `${primary}/.claude/worktrees/`;

  for (const br of ["infra/guard-last-cd-wins", "fix/a/b", "main"]) {
    const p = sh('babysit_tmp_dir "$1"', br);
    assert.ok(p.startsWith(root), `${br}: expected a path under ${root}, got ${p}`);
    assert.ok(!p.startsWith("-"), `${br}: path begins with '-' and rm would read it as an option: ${p}`);
    const dir = basename(p);
    assert.equal(dir, `.babysit-${br.replaceAll("/", "-")}`, `${br}: only the branch name is flattened`);
    assert.ok(!dir.includes("/"), `${br}: the directory name must be a single path segment`);
  }
});

test("the loop takes its path from the helper and no longer flattens it in place", () => {
  assert.match(script, /^\s*tmp=\$\(babysit_tmp_dir "\$br"\)\s*$/m, "merge-babysit.sh should call babysit_tmp_dir");
  assert.doesNotMatch(script, /tr '\/' '-'/, "the flattening belongs in lib/common.sh, where it is tested");
});

test("every rm and git worktree call that takes $tmp ends its options first", () => {
  const calls = [...script.matchAll(/(?:rm -rf|git worktree (?:add|remove))[^\n]*?"\$tmp"/g)].map((m) => m[0]);
  assert.ok(calls.length >= 4, `expected the add/add/remove/rm calls, found ${calls.length}: ${calls.join(" | ")}`);
  for (const c of calls) {
    assert.match(c, / -- "\$tmp"$/, `a path that could start with '-' must follow --: ${c}`);
  }
});
