#!/usr/bin/env node
// PreToolUse guard on Bash.
//
// Protocol: exit 2 with a reason on stderr blocks the call and shows the agent
// the message. Any other exit allows it. Internal errors allow -- a guard that
// throws must not brick every session in the repo, and a missed block is
// recoverable in a way that an unusable checkout is not.
//
// Every message names the allowed alternative. A block with no way forward
// gets papered over with a subshell within the hour, and then the guard is
// worse than nothing because everyone believes it is working.
//
// The decision function is pure -- (command, cwd, projectDir) -> message|null
// -- and is tested in bash-guard.test.mjs. Read that file before changing a
// pattern here; the regexes are easy to widen by accident.

import { statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const OVERRIDE = "PORTFOLIO_DESTRUCTIVE_OK=1";

// --- checkout classification -------------------------------------------------

/** `.git` is a directory in the primary checkout and a file in a linked worktree. */
export function checkoutKind(startDir, fsImpl = { statSync }) {
  let dir;
  try {
    dir = resolve(startDir);
  } catch {
    return null;
  }
  for (;;) {
    let st = null;
    try {
      st = fsImpl.statSync(join(dir, ".git"));
    } catch {
      st = null;
    }
    if (st) return { root: dir, primary: st.isDirectory() };
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// --- command parsing ---------------------------------------------------------

/**
 * Literal `cd` targets in a command string.
 *
 * `cd "$PRIMARY" && git commit` is skipped rather than guessed at: the guard
 * cannot know what the variable holds, and blocking on a maybe is how a guard
 * earns a reputation for crying wolf. Unexpanded variables are simply not
 * classified. The cost is that a determined session can route around this one
 * check; the check exists to catch the ordinary mistake, not the deliberate one.
 */
export function literalCdTargets(command) {
  const out = [];
  // cd, then either a "quoted path", a 'quoted path', or a bare run of
  // non-separator characters.
  const re = /(?:^|[;&|]|\&\&|\|\|)\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|<>]+))/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    const target = m[1] ?? m[2] ?? m[3];
    if (!target) continue;
    if (target.includes("$") || target.includes("`")) continue; // unexpanded
    out.push(target);
  }
  return out;
}

/** Strip a leading run of VAR=value assignments, returning them and the rest. */
export function splitLeadingAssignments(command) {
  const assignments = [];
  let rest = command.trimStart();
  for (;;) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*))\s+/.exec(rest);
    if (!m) break;
    assignments.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return { assignments, rest };
}

// --- rules -------------------------------------------------------------------

const PORT_CMD = "scripts/port.sh";

/**
 * @param {{command: string, cwd?: string, projectDir?: string, fsImpl?: object}} input
 * @returns {string|null} block message, or null to allow
 */
export function decide(input) {
  const command = String(input.command ?? "");
  if (!command.trim()) return null;

  const cwd = input.cwd ?? process.cwd();
  const fsImpl = input.fsImpl ?? { statSync };
  const { assignments, rest } = splitLeadingAssignments(command);
  const overridden = assignments.some((a) => a === OVERRIDE);

  // Where will this actually run? The last literal `cd` wins, as in a shell.
  const cdTargets = literalCdTargets(command);
  const effectiveDirs = [cwd, ...cdTargets.map((t) => (t.startsWith(sep) ? t : resolve(cwd, t)))];

  const anyPrimary = effectiveDirs.some((d) => {
    const k = checkoutKind(d, fsImpl);
    return k ? k.primary : false;
  });

  // 1. pkill / killall on a process name every session is running ------------
  //
  // There is no "my" python or "my" node on this machine. The dev servers of
  // three other sessions answer to the same name, and they will not be told
  // why they died.
  const kill = /\b(pkill|killall)\b([^\n]*)/.exec(command);
  if (kill) {
    const args = kill[2] || "";
    if (/\b(python3?|node|http\.server|ffmpeg|serve|claude)\b/.test(args) || /-f\s/.test(args)) {
      return [
        `Blocked: ${kill[1]} matches by name, and every parallel session in this repo`,
        `is running a process with that name. You would kill their preview servers and`,
        `encodes, and they would see only a dead port.`,
        ``,
        `Find the one pid bound to your own port, then kill that pid and nothing else:`,
        `    lsof -i :$(${PORT_CMD})`,
        `    kill <that pid>`,
      ].join("\n");
    }
  }

  // 2. destructive git, unless explicitly overridden --------------------------
  //
  // The override is the whole point. This hook exists to make you read the
  // status output first, not to stop you: the working tree may be holding
  // another session's only copy of something, as it is right now.
  const destructive = [
    [/\bgit\s+reset\s+(?:[^\n]*\s)?--hard\b/, "git reset --hard"],
    [/\bgit\s+clean\s+-[a-z]*f/, "git clean -f"],
    [/\bgit\s+checkout\s+(?:--\s+)?\.(?:\s|$)/, "git checkout -- ."],
    [/\bgit\s+restore\s+(?:[^\n]*\s)?(?:\.|--\s+\.)(?:\s|$)/, "git restore ."],
    // --force blocks, --force-with-lease does not: the lease is the check.
    // `-f` must be its own word, or `git push origin refs/heads/f` would trip.
    [/\bgit\s+push\b[^\n]*?\s(?:--force(?![-\w])|-f)(?=\s|$)/, "git push --force"],
    [/\bgit\s+branch\s+(?:[^\n]*\s)?-D\b/, "git branch -D"],
    [/\bgit\s+worktree\s+remove\s+[^\n]*--force\b/, "git worktree remove --force"],
    [/\bgit\s+worktree\s+prune\b/, "git worktree prune"],
  ];
  for (const [re, label] of destructive) {
    if (re.test(command)) {
      if (overridden) break;
      return [
        `Blocked: ${label} destroys work that no other session can see.`,
        `Uncommitted changes in this repo are invisible to the three other sessions`,
        `working in it, so "there was nothing important there" is not something you`,
        `can check from here.`,
        ``,
        `Read what you are about to lose first:`,
        `    git status --porcelain`,
        `    git stash list`,
        ``,
        `Then, if you still mean it, re-run the same command prefixed with:`,
        `    ${OVERRIDE} <your command>`,
      ].join("\n");
    }
  }

  // 3. building or committing in the primary checkout -------------------------
  //
  // The primary checkout stays on the default branch, clean, forever. It owns
  // the shared state -- the claims file, the lock, the 8.6 GB pipeline -- and
  // a session that commits there has put its work somewhere every other
  // session's scripts assume is stable.
  if (anyPrimary) {
    // (?![-\w]) and not \b: \b matches at a hyphen, so /git\s+merge\b/ also
    // matches `git merge-base` and /git\s+commit\b/ matches `git commit-tree`.
    // Both of those are read-only plumbing -- merge-base answers a question and
    // commit-tree writes an object nothing points at -- and blocking them
    // stopped a repair mid-incident before this was fixed.
    const writes = [
      [/\bgit\s+commit(?![-\w])/, "git commit"],
      [/\bgit\s+merge(?![-\w])(?![^\n]*--abort)/, "git merge"],
      [/\bgit\s+rebase(?![-\w])/, "git rebase"],
      [/\bgit\s+cherry-pick(?![-\w])/, "git cherry-pick"],
      [/\bgit\s+add(?![-\w])/, "git add"],
      [/\bgit\s+apply(?![-\w])/, "git apply"],
      [/\bffmpeg\b/, "ffmpeg"],
      [/\bcodex\s+exec\b/, "codex exec"],
    ];
    for (const [re, label] of writes) {
      if (re.test(rest) || re.test(command)) {
        return [
          `Blocked: ${label} in the primary checkout.`,
          `The primary checkout stays on the default branch, clean. It is what every`,
          `other session's tooling reads for shared state, and it is the one place`,
          `whose contents nobody expects to change under them.`,
          ``,
          `Cut a worktree and work there:`,
          `    scripts/git-new.sh <type>/<slug> "what you will touch"`,
          ``,
          `If you are already in one, you have a literal \`cd\` back to the primary`,
          `checkout somewhere in this command.`,
        ].join("\n");
      }
    }
  }

  // 4. merging must flow through the policy-enforcing script -------------------
  if (/\bgh\s+pr\s+merge\b/.test(command) || /\bgh\s+api\b[^\n]*\/pulls\/\d+\/merge\b/.test(command) || /\bgh\s+api\b[^\n]*\/merges\b/.test(command)) {
    return [
      `Blocked: direct merge.`,
      `Every push to the default branch publishes shanehaynes.com within a minute --`,
      `there is no staging environment between this command and the live site. Merges`,
      `run through the script that checks the merge policy first.`,
      ``,
      `    scripts/merge-babysit.sh            # dry run, says what it would merge`,
      `    scripts/merge-babysit.sh --yes      # merge what is green, current and allowed`,
    ].join("\n");
  }

  // 5. the agent must not grant itself the exception --------------------------
  //
  // merge-policy.mjs holds a path list, and a human lifts the hold per-PR with
  // a label. If the agent can apply that label, the boundary is decoration.
  if (/\bgh\s+(?:pr\s+edit|issue\s+edit)\b[^\n]*--add-label[^\n]*\bmerge-ok\b/.test(command) ||
      /\bgh\s+api\b[^\n]*labels[^\n]*\bmerge-ok\b/.test(command)) {
    return [
      `Blocked: applying the merge-ok label.`,
      `That label is how Shane lifts a HELD-path hold for one specific PR. An agent`,
      `that can apply it to its own PR has granted itself the authority the label was`,
      `invented to withhold.`,
      ``,
      `Say in the PR which HELD paths it touches and why, and ask for the label.`,
      `    scripts/merge-policy.mjs --explain <pr-number>`,
    ].join("\n");
  }

  // 6. never commit the fal.ai key -------------------------------------------
  if (/\bgit\s+add\b[^\n]*(?:-f|--force)[^\n]*\.env\.agents\b/.test(command) ||
      /\bgit\s+add\b[^\n]*\.env\.agents\b/.test(command)) {
    return [
      `Blocked: staging .env.agents.`,
      `It holds FAL_KEY. It is gitignored, it is for this machine's agents during`,
      `development, and it must never be committed, referenced from site code, or`,
      `shipped. A public repo makes that irreversible the moment it is pushed.`,
      ``,
      `New worktrees get a symlink to the primary checkout's copy automatically;`,
      `scripts/git-new.sh does it. Nothing else should ever touch this file.`,
    ].join("\n");
  }

  // 7. a fixed port is the whole reason for the resolver ----------------------
  //
  // This repo's version of Playwright's reuseExistingServer. There is no error
  // when it goes wrong: the session opens the port, sees a portfolio site, and
  // verifies a change it is not looking at.
  const httpServer = /\bpython3?\s+-m\s+http\.server(?:\s+(\d{2,5}))?/.exec(command);
  if (httpServer) {
    return [
      `Blocked: starting a preview server by hand${httpServer[1] ? ` on port ${httpServer[1]}` : " on the default port"}.`,
      `Every session that types this reaches for the same number. The second one to`,
      `try either fails to bind, or skips starting a server, opens the port, and`,
      `visually verifies another worktree's HTML. That failure is silent -- the page`,
      `loads, it just is not yours.`,
      ``,
      `Use this workspace's own port:`,
      `    scripts/serve.sh            # foreground`,
      `    scripts/serve.sh --bg       # background, logs under .claude/state/logs/`,
      `    ${PORT_CMD}              # just the number`,
    ].join("\n");
  }

  // 8. the photographs are not generated --------------------------------------
  //
  // The only rule in CLAUDE.md whose violation is unrecoverable: these are
  // Shane's own photographs of real people in real places, and an image_gen
  // pass over one replaces a photograph with a picture of nothing.
  if (/\bcodex\b[^\n]*\bimage_gen\b/.test(command) || /\bimage_gen\b[^\n]*\b(books|zion|wasatch|stansbury)\b/.test(command)) {
    if (/\b(books|zion|wasatch|stansbury)\b/.test(command) || /\bimages\//.test(command)) {
      return [
        `Blocked: image_gen against a photograph.`,
        `Everything in images/, and the books, zion, wasatch and stansbury stills`,
        `derived from them in media/, are Shane's own photographs of real people in`,
        `real places. Regenerating, extending or retouching one replaces a photograph`,
        `with something that only looks like it, and the original framing is gone.`,
        ``,
        `Re-encode from the original instead:`,
        `    scripts/with-media-lock.sh ffmpeg -i images/<source> ... media/<name>`,
        ``,
        `The hero video and its poster frame are the generated exception.`,
      ].join("\n");
    }
  }

  return null;
}

// --- hook entry point --------------------------------------------------------

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw);
  if (payload.tool_name && payload.tool_name !== "Bash") return;

  const message = decide({
    command: payload.tool_input?.command ?? "",
    cwd: payload.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    projectDir: process.env.CLAUDE_PROJECT_DIR,
  });

  if (message) {
    process.stderr.write(message + "\n");
    process.exit(2);
  }
}

// Fail open, always. A guard that throws on an unexpected payload shape would
// block every Bash call in every session in this repo at once, and the fix
// would have to be typed somewhere the guard is not running.
//
// pathToFileURL, not a string template: this checkout's path contains a space,
// which import.meta.url percent-encodes and a naive comparison does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
