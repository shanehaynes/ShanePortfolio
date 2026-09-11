# ShanePortfolio — agent notes

Static site for shanehaynes.com, served by GitHub Pages from `main`. Redesign in progress on the `redesign` branch. Plain HTML + CSS, near-zero JS, no build step.

## Media generation

- **Images:** the Codex CLI (`codex exec`) has a built-in `image_gen` tool billed to Shane's ChatGPT subscription. Use it only for stills that are meant to be generated.
- **The photographs on the site are not generated.** Everything in `images/`, and the `books`, `zion`, `wasatch`, and `stansbury` stills derived from them in `media/`, are Shane's own photographs of real people in real places. Never regenerate, extend, or retouch one with `image_gen` — re-encode from the original instead. The hero video and its poster frame are the generated exception.
- **Video:** fal.ai. The key lives in `.env.agents` as `FAL_KEY`. That file is gitignored and is for the agent's use during development only. It must never be read by, referenced from, or shipped with site code.
- Generation working files go in `.media-work/` (gitignored). Only finished, encoded assets are committed under `media/`.
- Verify every generated asset visually in a browser before committing it.

## Content

Source copy lives in `content/*.md`. Facts there are authoritative; wording may be revised.
