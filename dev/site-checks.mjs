#!/usr/bin/env node
// The checks a static site can actually fail.
//
// There is no build step here, so nothing catches a typo in an href until a
// visitor does. These five run in under a second and cover the mistakes this
// repo has actually made. Exit 0 clean, 1 with findings.
//
//   assets  every local path referenced from HTML or CSS exists on disk
//   ids     no duplicate id= within a page (anchors silently target the first)
//   meta    description and og:description match byte for byte, per content/meta.md
//   ports   no port number hardcoded outside the resolver
//   exif    no JPEG anywhere in the tree carries a GPS IFD

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

// --- exif gps ----------------------------------------------------------------
// Two camera originals in images/ carried a GPS IFD -- latitude and longitude
// to 0.01 arc-second, altitude, heading -- and Pages served them verbatim at
// /images/. The tags were zeroed in place (PR #22). This keeps the next photo
// from bringing them back: the whole tree is scanned, because a file does not
// have to be referenced from a page to be served.
//
// JPEG only. It is the one format here that arrives straight from a camera;
// PNG eXIf and WebP EXIF chunks are not scanned. The parser walks the JPEG
// segment headers to the APP1 Exif block and the TIFF IFD chain inside it
// (IFD0, then IFD1 for the thumbnail) looking for tag 0x8825, the GPSInfo
// pointer. It never decodes pixels, so 30 MB of originals cost milliseconds.
function tiffHasGpsIfd(t) {
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return false;
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (t.length < 8 || u16(2) !== 42) return false;
  const seen = new Set();
  let ifd = u32(4);
  while (ifd && ifd + 2 <= t.length && !seen.has(ifd)) {
    seen.add(ifd);
    const n = u16(ifd);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + 12 * k;
      if (e + 12 > t.length) return false;
      if (u16(e) === 0x8825) return true;
    }
    const next = ifd + 2 + 12 * n;
    ifd = next + 4 <= t.length ? u32(next) : 0;
  }
  return false;
}

function jpegHasGpsIfd(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }              // fill byte
    if (marker === 0xda || marker === 0xd9) break;       // scan data or EOI: headers are over
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1 && buf.subarray(i + 4, i + 10).equals(Buffer.from("Exif\0\0"))) {
      if (tiffHasGpsIfd(buf.subarray(i + 10, i + 2 + len))) return true;
    }
    i += 2 + len;
  }
  return false;
}

for (const f of files) {
  if (!/\.jpe?g$/i.test(f)) continue;
  let hit = false;
  try { hit = jpegHasGpsIfd(readFileSync(f)); } catch { continue; }
  if (hit) fail("exif", relative(ROOT, f), "carries a GPS IFD (EXIF tag 0x8825); strip it before committing");
}

// --- report ------------------------------------------------------------------
const CHECKS = ["assets", "ids", "meta", "ports", "exif"];
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
