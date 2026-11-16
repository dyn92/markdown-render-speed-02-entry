# markdown-render-speed-02 entry

<!-- Round 2 resubmit — rewritten under recording R4 (2026-11-16). -->
[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/dyn92/markdown-render-speed-02-entry/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/dyn92/markdown-render-speed-02-entry/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Built for the [make.fun "Make Markdown rendering faster" bounty](https://make.fun/bounty/markdown-render-speed-02).

A dependency-free, fast Markdown renderer for Node.

`parse.js` exports `parse(markdown)`, which returns byte-identical HTML to
what [marked](https://github.com/markedjs/marked) 18.1.3 renders with its
default options (GFM on, hard breaks off, pedantic off). It is a clean-room
reimplementation of marked's block/inline tokenizers, lexer and renderer,
with the grammar patterns compiled once at load and the dead option branches
(extensions, hooks, pedantic, breaks) removed.

`main.ts` is the harness driver: it reads `/input/cases.json` and writes
`/output/html.json` (or the paths in `MAKEFUN_INPUT_DIR` /
`MAKEFUN_OUTPUT_DIR` outside a container).

Verified against the practice set: 720/720 cases byte-exact, all 71 groups
pass the kit scorer.

## Run

```sh
node main.ts
```

No dependencies, no build step.
