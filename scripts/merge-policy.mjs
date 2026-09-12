#!/usr/bin/env node
// What an unattended session is allowed to merge.
//
//   node scripts/merge-policy.mjs --explain <pr-number>
//   node scripts/merge-policy.mjs --json <pr-number>
//
// This module fails CLOSED. No verdict means no merge -- the opposite of the
// Bash guard, which fails open. The asymmetry is deliberate and worth stating
// plainly, because someone will eventually read both and think one of them is
// a mistake:
//
//   The guard sits in front of every command a session runs. A guard that
//   failed closed on an unexpected payload would brick every session in the
//   repo at once, and the fix would have to be typed somewhere the guard is
//   not running. The cost of failing open is one missed block, which a human
//   can still catch.
//
//   This module sits in front of publishing to shanehaynes.com. A merge that
//   should not have happened is live on a public site under Shane's name
//   before anyone reads the log. There is no symmetric cost. When in doubt,
//   do nothing and say so.
//
// The HELD list is decided by blast radius, not by how sensitive the file
// looks. The question for each entry is: if this merges wrong, can it be
// undone by another commit? If yes, it does not belong here.

import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * Paths an unattended merge may not touch without an explicit human exception.
 * Each entry carries the reason, because a list without reasons gets trimmed
 * by the first person who finds it inconvenient.
 */
export const HELD = [
  // --- the automation's own authority ---------------------------------------
  // A PR that edits these is a PR that edits what the automation is allowed to
  // do. Self-amending authority is the one thing no bound can survive.
  [".claude/settings.json", "declares the hooks and the permission allow-list"],
  ["scripts/hooks/", "the guard that blocks destructive commands"],
  ["scripts/merge-policy.mjs", "this policy -- the thing deciding the merge"],
  ["scripts/merge-babysit.sh", "the merge actor"],
  ["scripts/", "every script the settings allow-list lets a session run unprompted"],
  ["dev/", "the port resolver and the gate; a wrong answer here routes a session to another session's site, or passes a build that is broken"],
  ["dev/port.mjs", "the port resolver; a wrong answer here routes a session to another session's site"],
  ["dev/site-checks.mjs", "the checks the gate runs; weakening one makes every later green meaningless"],

  // --- CI and publish configuration ------------------------------------------
  // _config.yml is this repo's CI config in everything but name: it is the
  // only thing standing between the internal working copy and the public web.
  // Dropping `content` from its exclude list republishes content/*.md at
  // shanehaynes.com/content/career.md. That has happened here once already.
  ["_config.yml", "the Jekyll exclude list; the only thing keeping content/ off the public site"],
  [".github/", "CI configuration"],

  // --- production routing ----------------------------------------------------
  // CNAME is the apex domain. An empty or deleted CNAME unpoints
  // shanehaynes.com from Pages, and the recovery is DNS-propagation slow.
  ["CNAME", "production routing for the apex domain"],

  // --- irreversible disclosure -----------------------------------------------
  // If .env.agents comes off the ignore list, the next `git add -A` commits
  // FAL_KEY to a public repository. Rotating the key does not un-publish it.
  [".gitignore", "keeps .env.agents (FAL_KEY) and 8.6 GB of working files out of a public repo"],

  // --- dependency manifests ---------------------------------------------------
  // None of these exist yet. The hold exists so that the PR which introduces
  // the first one is read by a human, since it introduces a supply chain to a
  // repo that currently has none.
  ["package.json", "would introduce a dependency tree to a repo that has none"],
  ["package-lock.json", "dependency resolution"],
  ["Gemfile", "dependency resolution"],
  ["Gemfile.lock", "dependency resolution"],

  // --- the rules themselves ---------------------------------------------------
  // Prose, but prose every future session reads as instructions.
  ["CLAUDE.md", "the standing instructions every session in this repo loads"],
  ["CONTRIBUTING.md", "the reasons behind those instructions"],
];

export const EXCEPTION_LABEL = "merge-ok";

export function heldReasonFor(path) {
  // Longest match wins so scripts/merge-policy.mjs reports its own reason
  // rather than the generic scripts/ one.
  let best = null;
  for (const [prefix, reason] of HELD) {
    const hit = prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix;
    if (hit && (!best || prefix.length > best[0].length)) best = [prefix, reason];
  }
  return best ? { prefix: best[0], reason: best[1] } : null;
}

/**
 * Pure. Everything that could fail lives in the caller.
 *
 * @param {object} pr
 * @param {string[]} pr.files          changed paths
 * @param {string[]} pr.labels
 * @param {string} pr.baseRef
 * @param {string} pr.defaultBranch
 * @param {string} pr.ciState          "green" | "red" | "pending" | "none" | unknown
 * @param {boolean} pr.mergeable
 * @param {boolean} pr.draft
 * @param {boolean} pr.halted
 * @returns {{allow: boolean, verdict: string, reasons: string[], held: object[]}}
 */
export function evaluate(pr) {
  const reasons = [];
  const missing = [];
  for (const k of ["files", "labels", "baseRef", "defaultBranch"]) {
    if (pr?.[k] === undefined || pr?.[k] === null) missing.push(k);
  }
  if (missing.length) {
    // Fail closed. An absent field is not an empty field.
    return {
      allow: false,
      verdict: "NO VERDICT",
      reasons: [`cannot decide: missing ${missing.join(", ")}. Policy fails closed.`],
      held: [],
    };
  }

  // Kill switch first, so it halts a run already in progress at the next PR.
  if (pr.halted) {
    return { allow: false, verdict: "HALTED", reasons: ["the halt file exists"], held: [] };
  }

  if (pr.draft) reasons.push("PR is a draft");

  // Never merge a PR based on anything but the default branch. A stacked PR
  // merged in the wrong order merges into its base branch, not into main, and
  // the PR closes looking successful.
  if (pr.baseRef !== pr.defaultBranch) {
    reasons.push(`based on ${pr.baseRef}, not ${pr.defaultBranch} -- skip, never merge a stacked PR`);
  }

  if (pr.mergeable === false) reasons.push("not mergeable (conflicts with the default branch)");
  else if (pr.mergeable === null || pr.mergeable === undefined) {
    // GitHub computes mergeability lazily and reports UNKNOWN until it
    // finishes. Treating that as "fine" is how this policy would merge on
    // incomplete information -- observed on PR #6, which read UNKNOWN on one
    // call and CONFLICTING on the next, seconds apart. Unknown is not a yes.
    reasons.push("mergeability is still UNKNOWN -- GitHub has not finished computing it; ask again");
  }
  if (pr.ciState === "red") reasons.push("checks are failing");
  else if (pr.ciState === "pending") reasons.push("checks are still running");
  else if (pr.ciState !== "green" && pr.ciState !== "none") {
    reasons.push(`check state is ${JSON.stringify(pr.ciState)} -- not a state this policy knows`);
  }

  const held = [];
  for (const f of pr.files) {
    const h = heldReasonFor(f);
    if (h) held.push({ path: f, ...h });
  }

  const hasException = pr.labels.includes(EXCEPTION_LABEL);
  if (held.length > 0 && !hasException) {
    reasons.push(
      `touches ${held.length} HELD path(s) without the "${EXCEPTION_LABEL}" label`,
    );
  }

  if (reasons.length > 0) {
    return { allow: false, verdict: "HOLD", reasons, held };
  }
  return {
    allow: true,
    verdict: "MERGE",
    reasons: hasException && held.length
      ? [`HELD paths cleared by the "${EXCEPTION_LABEL}" label`]
      : ["green, current, and touches no HELD path"],
    held,
  };
}

// --- CLI ----------------------------------------------------------------------

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function primaryDir() {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
  const abs = common.startsWith("/") ? common : `${process.cwd()}/${common}`;
  return execFileSync("sh", ["-c", `cd "${abs}/.." && pwd`], { encoding: "utf8" }).trim();
}

export function fetchPr(number) {
  const fields = "number,title,headRefName,baseRefName,labels,isDraft,mergeable,files,statusCheckRollup";
  const raw = JSON.parse(gh(["pr", "view", String(number), "--json", fields]));
  const rollup = raw.statusCheckRollup ?? [];
  let ciState = "none";
  if (rollup.length > 0) {
    const states = rollup.map((c) => c.conclusion || c.state || "").map((s) => s.toUpperCase());
    if (states.some((s) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(s))) ciState = "red";
    else if (states.some((s) => ["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", ""].includes(s))) ciState = "pending";
    else ciState = "green";
  }
  let defaultBranch = "main";
  try {
    defaultBranch = JSON.parse(gh(["repo", "view", "--json", "defaultBranchRef"])).defaultBranchRef.name;
  } catch { /* fall through to the default; evaluate() still compares honestly */ }

  const halted = existsSync(`${primaryDir()}/.claude/state/HALT`);

  return {
    number: raw.number,
    title: raw.title,
    headRef: raw.headRefName,
    files: (raw.files ?? []).map((f) => f.path),
    labels: (raw.labels ?? []).map((l) => l.name),
    baseRef: raw.baseRefName,
    defaultBranch,
    ciState,
    mergeable: raw.mergeable === "MERGEABLE" ? true : raw.mergeable === "CONFLICTING" ? false : null,
    draft: !!raw.isDraft,
    halted,
  };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const num = args.find((a) => /^\d+$/.test(a));
  if (!num) {
    console.error("usage: node scripts/merge-policy.mjs [--explain|--json] <pr-number>");
    process.exit(2);
  }

  let pr, result;
  try {
    pr = fetchPr(num);
    result = evaluate(pr);
  } catch (err) {
    // Fail closed, loudly.
    const out = { allow: false, verdict: "NO VERDICT", reasons: [String(err.message ?? err)] };
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      console.error(`PR #${num}: NO VERDICT -- ${out.reasons[0]}`);
      console.error("Policy fails closed: no verdict, no merge.");
    }
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify({ ...result, pr }, null, 2));
    process.exit(result.allow ? 0 : 1);
  }

  console.log(`PR #${pr.number}  ${pr.title}`);
  console.log(`  ${pr.headRef} -> ${pr.baseRef}   checks: ${pr.ciState}   labels: ${pr.labels.join(", ") || "(none)"}`);
  console.log("");
  console.log(`  ${result.verdict}`);
  for (const r of result.reasons) console.log(`    - ${r}`);
  if (result.held.length) {
    console.log("");
    console.log("  HELD paths in this PR:");
    for (const h of result.held) console.log(`    ${h.path}\n        ${h.reason}`);
    if (!pr.labels.includes(EXCEPTION_LABEL)) {
      console.log("");
      console.log(`  Shane lifts this per-PR with the "${EXCEPTION_LABEL}" label.`);
      console.log("  Ask for it in the PR and say which HELD paths it covers and why.");
      console.log("  An agent applying that label to its own PR is blocked by the Bash guard.");
    }
  }
  process.exit(result.allow ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
