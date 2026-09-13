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
import { dirname, join, resolve } from "node:path";
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
 * Every literal `cd` in a command string, with where in the string it sits.
 *
 * `cd "$PRIMARY" && git commit` is skipped rather than guessed at: the guard
 * cannot know what the variable holds, and blocking on a maybe is how a guard
 * earns a reputation for crying wolf. Unexpanded variables are simply not
 * classified. The cost is that a determined session can route around this one
 * check; the check exists to catch the ordinary mistake, not the deliberate one.
 */
export function cdSteps(command) {
  const out = [];
  // cd, then either a "quoted path", a 'quoted path', or a bare run of
  // non-separator characters.
  const re = /(?:^|[;&|]|\&\&|\|\|)\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|<>]+))/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    const target = m[1] ?? m[2] ?? m[3];
    if (!target) continue;
    if (target.includes("$") || target.includes("`")) continue; // unexpanded
    out.push({ target, index: m.index });
  }
  return out;
}

/** The targets alone. */
export function literalCdTargets(command) {
  return cdSteps(command).map((s) => s.target);
}

/**
 * The directory the shell is standing in when it reaches `index` in the
 * command: cwd, then every literal cd before that point applied in order, a
 * relative one taken from wherever the previous cd left off. The last cd
 * wins, as in a shell. A cd after the point has not happened yet.
 */
export function dirAt(command, cwd, index = Infinity) {
  let dir = cwd;
  for (const step of cdSteps(command)) {
    if (step.index > index) break;
    dir = resolve(dir, step.target);
  }
  return dir;
}

/** Global git options that take their value as the next word. */
const GIT_VALUE_OPTS = new Set(["--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);

/**
 * Every `git` invocation in a command: its literal `-C` targets, the verb
 * that follows the global options, and that verb's arguments.
 *
 * `git -C <path> commit` runs in <path>, not where the shell is standing, so
 * the primary-checkout rule has to read it, in both directions. Before this
 * existed, `git -C <primary> commit` from a worktree slipped through, because
 * the pattern wanted `git` directly followed by `commit`. The other global
 * options git takes before the verb (`-c k=v`, `--no-pager`, `--git-dir=..`)
 * are stepped over for the same reason. An unexpanded `-C "$DIR"` is dropped,
 * exactly as cdSteps drops `cd "$DIR"`.
 */
export function gitInvocations(command) {
  const out = [];
  const word = /\bgit(?=\s)/g;
  // A token is a "quoted", 'quoted' or bare run on the same line; a shell
  // separator ends the invocation.
  const token = /[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s;&|<>()]+))/y;
  let m;
  while ((m = word.exec(command)) !== null) {
    const tokens = [];
    token.lastIndex = m.index + 3;
    let t;
    while ((t = token.exec(command)) !== null) {
      tokens.push(t[1] ?? t[2] ?? t[3]);
      // Resume the search for the next `git` after this one's arguments, so a
      // commit message that mentions git is not read as a second invocation.
      word.lastIndex = token.lastIndex;
    }
    const dirs = [];
    let subcommand = null;
    let i = 0;
    for (; i < tokens.length; i++) {
      const tk = tokens[i];
      if (tk === "-C" || tk === "-c" || GIT_VALUE_OPTS.has(tk)) {
        const v = tokens[++i];
        if (tk === "-C" && v && !/[$`]/.test(v)) dirs.push(v);
      } else if (tk.startsWith("-C")) {
        if (!/[$`]/.test(tk)) dirs.push(tk.slice(2)); // -C<path>, no space
      } else if (tk.startsWith("-")) {
        // -c<k=v>, --git-dir=<x>, -p, --no-pager, --bare: no directory in them
      } else {
        subcommand = tk;
        break;
      }
    }
    if (subcommand === null) continue;
    out.push({ subcommand, args: tokens.slice(i + 1), dirs, index: m.index });
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
  const { assignments } = splitLeadingAssignments(command);
  const overridden = assignments.some((a) => a === OVERRIDE);

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
  //
  // Each command is judged where it will actually run, not where the shell
  // started: the last literal cd before it wins, as in a shell, and `git -C`
  // moves a git command once more on top of that. An earlier version blocked
  // if ANY directory in the chain was the primary, so a session standing in
  // the primary checkout could not follow this guard's own advice -- cut a
  // worktree, cd into it, commit there.
  const inPrimary = (dir) => {
    const k = checkoutKind(dir, fsImpl);
    return k ? k.primary : false;
  };
  const blockedInPrimary = (label) => [
    `Blocked: ${label} in the primary checkout.`,
    `The primary checkout stays on the default branch, clean. It is what every`,
    `other session's tooling reads for shared state, and it is the one place`,
    `whose contents nobody expects to change under them.`,
    ``,
    `Cut a worktree and work there:`,
    `    scripts/git-new.sh <type>/<slug> "what you will touch"`,
    ``,
    `If you are already in a worktree, this command steps back into the primary`,
    `checkout with a literal \`cd\` or \`git -C\`. If you named the worktree through`,
    `a shell variable instead, spell the path out: the guard reads literal paths only.`,
  ].join("\n");

  // The verb is compared whole, so `git merge-base` is not `git merge` and
  // `git commit-tree` is not `git commit`. Both are read-only plumbing --
  // merge-base answers a question, commit-tree writes an object nothing points
  // at -- and a pattern that blocked them stopped a repair mid-incident once.
  const gitWrites = new Map([
    ["commit", "git commit"],
    ["merge", "git merge"],
    ["rebase", "git rebase"],
    ["cherry-pick", "git cherry-pick"],
    ["add", "git add"],
    ["apply", "git apply"],
  ]);
  for (const inv of gitInvocations(command)) {
    const label = gitWrites.get(inv.subcommand);
    if (!label) continue;
    if (inv.subcommand === "merge" && inv.args.includes("--abort")) continue; // a recovery, not a build
    const dir = inv.dirs.reduce((d, t) => resolve(d, t), dirAt(command, cwd, inv.index));
    if (inPrimary(dir)) return blockedInPrimary(label);
  }
  for (const [re, label] of [[/\bffmpeg\b/g, "ffmpeg"], [/\bcodex\s+exec\b/g, "codex exec"]]) {
    for (const m of command.matchAll(re)) {
      if (inPrimary(dirAt(command, cwd, m.index))) return blockedInPrimary(label);
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
