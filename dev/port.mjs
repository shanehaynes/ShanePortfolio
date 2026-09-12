// The one place a port number is decided.
//
// Every consumer imports resolvePort() from here -- the preview server, any
// scripted driver, the supervisor report. Three consumers that each compute a
// port are three consumers that can disagree, and the way you find out they
// disagreed is that a session verifies its change against another session's
// site and sees no error at all.
//
// Resolution order:
//   1. PORTFOLIO_PORT, if set. Validated, never silently ignored.
//   2. 8000 in the primary checkout -- python3 -m http.server's own default,
//      so the number a human types by reflex stays true where they type it.
//   3. Otherwise a hash of the worktree directory name into 5200-5999.
//
// 5200-5999 is clear of everything this machine runs: 8000 (the primary),
// 8765, and the 54321-54324 block. 800 slots for a repo that will never hold
// more than a handful of live worktrees -- collisions are possible in
// principle and have never been the problem. The point is determinism: the
// same worktree gets the same port tomorrow, so a bookmarked tab keeps
// working and a session that prints the URL is not lying an hour later.

import { statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PRIMARY_PORT = 8000;
export const DERIVED_MIN = 5200;
export const DERIVED_MAX = 5999;
export const PORT_ENV = "PORTFOLIO_PORT";

/**
 * Walk up from `start` to the checkout root -- the first directory holding a
 * `.git` entry of any kind.
 *
 * Returns { root, primary }. `primary` uses the test used everywhere else in
 * this repo's tooling: `.git` is a *directory* in the primary checkout and a
 * *file* (one line, "gitdir: ...") in a linked worktree. Cheap, no subprocess,
 * and it cannot be fooled by a stale environment variable.
 */
export function findCheckout(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    let st;
    try {
      st = statSync(join(dir, ".git"));
    } catch {
      st = null;
    }
    if (st) return { root: dir, primary: st.isDirectory() };
    const up = dirname(dir);
    // No checkout anywhere above. Returning a "derived" port for a directory
    // that is not part of this repo would be inventing an answer to a question
    // that has none -- and it did, silently, for /tmp.
    if (up === dir) return null;
    dir = up;
  }
}

/** FNV-1a, 32-bit. Only has to spread ~800 slots and be stable across runs. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h * 16777619 in 32-bit arithmetic, kept out of float range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Throws on a malformed PORTFOLIO_PORT rather than falling through to the
 * derived port. A typo that silently resolves to a different-but-valid port is
 * the same silent-wrong-target bug this module exists to prevent -- the
 * session would be told 5431 and be served on 5723.
 */
export function parsePortEnv(raw, envName = PORT_ENV) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`${envName}=${JSON.stringify(raw)} is not a number.`);
  }
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`${envName}=${s} is out of range (1024-65535).`);
  }
  return n;
}

export function derivePort(worktreeDirName) {
  const span = DERIVED_MAX - DERIVED_MIN + 1;
  return DERIVED_MIN + (fnv1a(worktreeDirName) % span);
}

/**
 * @param {{cwd?: string, env?: object}} [opts]
 * @returns {{port: number, source: "env"|"primary"|"derived", root: string, primary: boolean}}
 */
export function resolvePort(opts = {}) {
  const env = opts.env ?? process.env;
  const where = opts.cwd ?? process.cwd();
  const found = findCheckout(where);
  if (!found) throw new Error(`${where} is not inside a git checkout; there is no port for it.`);
  const { root, primary } = found;

  const fromEnv = parsePortEnv(env[PORT_ENV]);
  if (fromEnv !== null) return { port: fromEnv, source: "env", root, primary };

  if (primary) return { port: PRIMARY_PORT, source: "primary", root, primary };

  return { port: derivePort(basename(root)), source: "derived", root, primary };
}

// pathToFileURL, not a `file://${argv[1]}` template: this repo's own path
// contains a space ("Portfolio Web App"), which import.meta.url percent-encodes
// and a raw template does not. The naive comparison is false here, always, and
// the CLI silently prints nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const verbose = process.argv.includes("--verbose");
  // An explicit directory beats cwd. Callers that know which checkout they
  // mean should say so rather than relying on where the shell happens to be.
  const dirArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  try {
    const r = resolvePort(dirArg ? { cwd: dirArg } : {});
    if (verbose) {
      console.log(`port   ${r.port}`);
      console.log(`source ${r.source}`);
      console.log(`root   ${r.root}`);
      console.log(`kind   ${r.primary ? "primary checkout" : "linked worktree"}`);
    } else {
      console.log(r.port);
    }
  } catch (err) {
    console.error(`port: ${err.message}`);
    process.exit(1);
  }
}
