# ShanePortfolio — agent notes

Static site for shanehaynes.com, served by GitHub Pages from `main`. Plain HTML + CSS,
near-zero JS, no build step.

**Several Claude sessions work in this repo at once, and none of them can see another's
uncommitted changes.** Most of what follows exists because of that. CONTRIBUTING.md has the
reasoning; this file has the rules and the commands.

## Start here

```
scripts/git-new.sh <type>/<slug> "what you will touch"
```

Types: `feat` `fix` `chore` `copy` `media` `infra`. It cuts a worktree from `origin/main`,
derives a preview port, records your intent where other sessions can see it, and prints
everyone else's claims. **If a printed claim names a file you were about to touch,
coordinate or wait** — two branches editing adjacent lines each merge cleanly into `main`
and then conflict with each other.

The primary checkout stays on `main`, clean, forever. It is for reading and for owning
shared state. Nothing is built or committed there; a hook enforces it.

## Every day

| | |
|---|---|
| `scripts/serve.sh` | preview this worktree, on this worktree's port |
| `scripts/check.sh` | the gate: asset references, duplicate ids, meta parity, unit tests |
| `scripts/port.sh` | just the number |
| `scripts/supervisor-report.sh` | what rotted since yesterday; `ACTION` lines need a human |
| `scripts/git-tidy.sh` | dry run; `--yes` to retire what has landed |

Never start a preview server by hand. Every session reaches for the same default port, and
the one that loses opens it anyway and visually verifies **another worktree's HTML**. That
failure is silent — the page loads, it just is not yours. `scripts/serve.sh` uses a port
derived from your worktree's name. To find what is on yours:

```
lsof -i :$(scripts/port.sh)
```

## Before several PRs open

```
scripts/combine-check.sh --check
```

Each branch merging into `main` on its own is not the question. This asks whether they merge
into `main` *after each other*, and whether the combination still builds. On a conflict, move
one hunk to the far side of an unchanged line. **Do not stack the PRs** — head branches are
not auto-deleted here, and a stack merged in the wrong order merges a PR into its base branch
instead of `main`.

## Merging

```
scripts/merge-babysit.sh          # the plan
scripts/merge-babysit.sh --yes    # merge what is green, current and allowed
```

Merging is serial because **every push to `main` publishes shanehaynes.com within the
minute.** There is no staging step. A hook blocks direct merge commands so they go through
the policy.

`scripts/merge-policy.mjs` HOLDS paths whose blast radius is irreversible — `CNAME`,
`_config.yml`, `.gitignore`, `scripts/`, `dev/`, `.claude/settings.json`, `CLAUDE.md`.
Shane lifts a hold per-PR with the `merge-ok` label. An agent may not apply that label to
its own PR; the hook blocks it. Ask in the PR and say which HELD paths it covers and why.

Kill switch: create `.claude/state/HALT` and every run stops, including one already looping.

## Media generation

The pipeline is **single-holder**. `.media-work/` (8.6 GB, in the primary checkout), the
fal.ai account, and `codex exec`'s `image_gen` are one each. Wrap everything that touches
them:

```
scripts/with-media-lock.sh <command>
scripts/media-drift.sh              # am I re-encoding from a stale base?
```

`.media-work/` holds the state of the last run, not the state of `main`.

- **Images:** the Codex CLI (`codex exec`) has a built-in `image_gen` tool billed to Shane's
  ChatGPT subscription. Use it only for stills that are meant to be generated.
- **The photographs on the site are not generated.** Everything in `images/`, and the
  `books`, `zion`, `wasatch`, and `stansbury` stills derived from them in `media/`, are
  Shane's own photographs of real people in real places. Never regenerate, extend, or
  retouch one — re-encode from the original instead. A hook enforces this. The hero video
  and its poster frame are the generated exception.
- **Video:** fal.ai. The key lives in `.env.agents` as `FAL_KEY`. That file is gitignored and
  is for the agent's use during development only. It must never be read by, referenced from,
  or shipped with site code.
- Generation working files go in `.media-work/` (gitignored). Only finished, encoded assets
  are committed under `media/`.
- Verify every generated asset visually in a browser before committing it.

## Content

Source copy lives in `content/*.md`. Facts there are authoritative; wording may be revised.
On every page, `meta name="description"` and `og:description` carry the same string byte for
byte — `scripts/check.sh` enforces it.

## When a hook blocks you

The message names the alternative. Take it. If you genuinely mean a destructive git command,
read `git status --porcelain` first — that working tree may be another session's only copy —
then re-run prefixed with `PORTFOLIO_DESTRUCTIVE_OK=1`. The override must lead the whole
command, not sit inside a loop.

Writing documentation that quotes a banned command trips the guard, because the patterns
match the whole command string. Use the file tools for those, not a heredoc.
