# ShanePortfolio — agent notes

Static site for shanehaynes.com, served by GitHub Pages from `main`. Redesign in progress on the `redesign` branch. Plain HTML + CSS, near-zero JS, no build step.

## Media generation

- **Images:** the Codex CLI (`codex exec`) has a built-in `image_gen` tool billed to Shane's ChatGPT subscription. Use it for all stills.
- **Video:** fal.ai. The key lives in `.env.agents` as `FAL_KEY`. That file is gitignored and is for the agent's use during development only. It must never be read by, referenced from, or shipped with site code.
- Generation working files go in `.media-work/` (gitignored). Only finished, encoded assets are committed under `media/`.
- Verify every generated asset visually in a browser before committing it.

## Content

Source copy lives in `content/*.md`. Facts there are authoritative; wording may be revised.
