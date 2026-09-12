// node --test scripts/merge-policy.test.mjs
//
// evaluate() is pure. The tests that matter are the ones proving it refuses
// when it does not know -- a policy that only gets the happy path right is a
// policy that merges on a malformed API response.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, heldReasonFor, HELD, EXCEPTION_LABEL } from "./merge-policy.mjs";

const ok = {
  files: ["index.html", "style.css"],
  labels: [],
  baseRef: "main",
  defaultBranch: "main",
  ciState: "green",
  mergeable: true,
  draft: false,
  halted: false,
};
const pr = (over = {}) => evaluate({ ...ok, ...over });

test("a green PR touching nothing held merges", () => {
  const r = pr();
  assert.equal(r.allow, true);
  assert.equal(r.verdict, "MERGE");
});

test("the ordinary work of this repo is not held", () => {
  for (const f of ["index.html", "personal.html", "record.html", "style.css", "content/career.md", "media/hero-poster.jpg", "images/books.jpeg"]) {
    assert.equal(heldReasonFor(f), null, `${f} should not be HELD -- holding it makes the automation useless`);
  }
});

test("every HELD entry carries a reason", () => {
  for (const [prefix, reason] of HELD) {
    assert.ok(reason && reason.length > 10, `${prefix} has no real reason attached`);
  }
});

test("HELD paths block without the label", () => {
  for (const f of [
    ".claude/settings.json",
    "scripts/hooks/bash-guard.mjs",
    "scripts/git-new.sh",
    "scripts/merge-policy.mjs",
    "dev/port.mjs",
    "_config.yml",
    "CNAME",
    ".gitignore",
    "package.json",
    "CLAUDE.md",
    ".github/workflows/ci.yml",
  ]) {
    const r = pr({ files: ["index.html", f] });
    assert.equal(r.allow, false, `${f} should be HELD`);
    assert.equal(r.verdict, "HOLD");
    assert.ok(r.held.some((h) => h.path === f));
  }
});

test("the longest matching prefix supplies the reason", () => {
  assert.match(heldReasonFor("scripts/merge-policy.mjs").reason, /this policy/);
  assert.match(heldReasonFor("scripts/git-new.sh").reason, /allow-list/);
  assert.match(heldReasonFor("scripts/hooks/bash-guard.mjs").reason, /guard/);
});

test("the label lifts the hold, and only for the PR carrying it", () => {
  const held = { files: ["_config.yml"] };
  assert.equal(pr(held).allow, false);
  assert.equal(pr({ ...held, labels: [EXCEPTION_LABEL] }).allow, true);
  assert.equal(pr({ ...held, labels: ["needs-review", "documentation"] }).allow, false);
});

test("the label does not paper over a red build", () => {
  const r = pr({ files: ["_config.yml"], labels: [EXCEPTION_LABEL], ciState: "red" });
  assert.equal(r.allow, false);
  assert.ok(r.reasons.some((x) => /checks are failing/.test(x)));
});

test("a stacked PR is skipped, never merged", () => {
  const r = pr({ baseRef: "feat/other" });
  assert.equal(r.allow, false);
  assert.ok(r.reasons.some((x) => /never merge a stacked PR/.test(x)));
});

test("red, pending and unknown check states all hold", () => {
  assert.equal(pr({ ciState: "red" }).allow, false);
  assert.equal(pr({ ciState: "pending" }).allow, false);
  assert.equal(pr({ ciState: "weird" }).allow, false);
});

test("a repo with no checks at all can still merge -- that is this repo today", () => {
  assert.equal(pr({ ciState: "none" }).allow, true);
});

test("drafts and conflicts hold", () => {
  assert.equal(pr({ draft: true }).allow, false);
  assert.equal(pr({ mergeable: false }).allow, false);
});

test("UNKNOWN mergeability holds -- unknown is not a yes", () => {
  // GitHub computes mergeability lazily. PR #6 in this repo read UNKNOWN on
  // one call and CONFLICTING on the next, seconds apart. A policy that treats
  // UNKNOWN as fine merges on information it does not have.
  for (const v of [null, undefined]) {
    const r = pr({ mergeable: v });
    assert.equal(r.allow, false);
    assert.ok(r.reasons.some((x) => /UNKNOWN/.test(x)));
  }
});

test("the halt file stops everything, including an allowed PR", () => {
  const r = pr({ halted: true });
  assert.equal(r.allow, false);
  assert.equal(r.verdict, "HALTED");
});

test("the policy fails closed on missing information", () => {
  for (const k of ["files", "labels", "baseRef", "defaultBranch"]) {
    const input = { ...ok };
    delete input[k];
    const r = evaluate(input);
    assert.equal(r.allow, false, `missing ${k} must not merge`);
    assert.equal(r.verdict, "NO VERDICT");
  }
  assert.equal(evaluate({}).allow, false);
  assert.equal(evaluate(null).allow, false);
  assert.equal(evaluate(undefined).allow, false);
});

test("an empty file list is not the same as a missing one", () => {
  assert.equal(evaluate({ ...ok, files: [] }).allow, true);
});
