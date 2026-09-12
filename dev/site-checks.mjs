#!/usr/bin/env node
// The checks a static site can actually fail.
//
// There is no build step here, so nothing catches a typo in an href until a
// visitor does. These four run in under a second and cover the mistakes this
// repo has actually made. Exit 0 clean, 1 with findings.
//
//   assets  every local path referenced from HTML or CSS exists on disk
//   ids     no duplicate id= within a page (anchors silently target the first)
//   meta    description and og:description match byte for byte, per content/meta.md
//   ports   no port number hardcoded outside the resolver

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();

const findings = [];
const fail = (check, file, msg) => findings.push({ check, file, msg });

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = existsSync(ROOT) ? walk(ROOT) : [];
const html = files.filter((f) => f.endsWith(".html"));
const css = files.filter((f) => f.endsWith(".css"));

// --- assets ------------------------------------------------------------------
// Skips absolute URLs, protocol-relative URLs, anchors, mailto: and data:.
const isLocal = (u) =>
  u &&
  !/^[a-z][a-z0-9+.-]*:/i.test(u) &&
  !u.startsWith("//") &&
  !u.startsWith("#") &&
  !u.startsWith("{");

function checkRef(sourceFile, ref) {
  const clean = ref.split("#")[0].split("?")[0].trim();
  if (!clean || !isLocal(clean)) return;
  // Root-relative resolves from the site root; otherwise from the file.
  const target = clean.startsWith("/")
    ? join(ROOT, clean.slice(1))
    : resolve(dirname(sourceFile), clean);
  // A directory reference means its index.html.
  const candidates = [target, join(target, "index.html")];
  if (!candidates.some((c) => existsSync(c))) {
    fail("assets", relative(ROOT, sourceFile), `references ${clean}, which does not exist`);
  }
}

for (const f of html) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)) checkRef(f, m[1]);
  // srcset: "path 1x, path 2x" / "path 600w, path 1200w"
  for (const m of src.matchAll(/srcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const part of m[1].split(",")) checkRef(f, part.trim().split(/\s+/)[0]);
  }
}
for (const f of css) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) checkRef(f, m[1]);
}

// --- duplicate ids -----------------------------------------------------------
// Two elements with one id is the silent kind of broken: the in-page anchor
// scrolls to whichever came first and nothing reports the other.
for (const f of html) {
  const src = readFileSync(f, "utf8");
  const seen = new Map();
  for (const m of src.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)) {
    const id = m[1];
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const [id, n] of seen) {
    if (n > 1) fail("ids", relative(ROOT, f), `id="${id}" appears ${n} times`);
  }
}

// --- meta description parity -------------------------------------------------
// content/meta.md makes this a rule so that a one-sided edit shows up in the
// diff. Enforcing it here is what makes that true of a diff nobody reads.
for (const f of html) {
  const src = readFileSync(f, "utf8");
  const name = /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i.exec(src);
  const og = /<meta\s+property=["']og:description["']\s+content=["']([^"']*)["']/i.exec(src);
  if (name && og && name[1] !== og[1]) {
    fail("meta", relative(ROOT, f), "description and og:description differ");
  }
}

// --- port hardcodes ----------------------------------------------------------
// The resolver only works if it is the only opinion. A second number in a
// script or a doc is a second answer, and the way that shows up is a session
// verifying its change against another worktree's site.
const RESOLVER = join(ROOT, "dev", "port.mjs");
for (const f of files) {
  if (f === RESOLVER) continue;
  // Test files quote ports as fixtures. A fixture is not a consumer -- it
  // never binds and never connects -- and excluding them keeps the check
  // about the thing it is for: two pieces of running code disagreeing.
  if (f.endsWith(".test.mjs")) continue;
  if (!/\.(mjs|js|sh|md|html|css|json|ya?ml)$/.test(f)) continue;
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/localhost:(\d{4,5})|127\.0\.0\.1:(\d{4,5})|http\.server\s+(\d{4,5})/g)) {
    const port = m[1] ?? m[2] ?? m[3];
    fail("ports", relative(ROOT, f), `hardcodes port ${port}; use scripts/port.sh or dev/port.mjs`);
  }
}

// --- report ------------------------------------------------------------------
const CHECKS = ["assets", "ids", "meta", "ports"];
let failedChecks = 0;
for (const c of CHECKS) {
  const hits = findings.filter((f) => f.check === c);
  if (hits.length === 0) {
    console.log(`  ok    ${c}`);
  } else {
    failedChecks++;
    console.log(`  FAIL  ${c}`);
    for (const h of hits) console.log(`          ${h.file}: ${h.msg}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(failedChecks === 0 ? 0 : 1);
}
