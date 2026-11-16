# markdown-render-speed-02-v1

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/aurorabelle788/markdown-render-speed-02-v1/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/aurorabelle788/markdown-render-speed-02-v1/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, single-file drop-in for marked 18.1.3 that renders CommonMark 0.31.2 + GFM to byte-identical HTML, restructured for speed: a hand-rolled inline text scanner, first-character dispatch in the block and inline loops, and cheap guards in front of the expensive block regexes.

## Run it

```sh
node main.ts
```

Reads the cases from `$MAKEFUN_INPUT_DIR/cases.json` (default `/input`) and writes the rendered HTML array to `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=azvv97zj&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
