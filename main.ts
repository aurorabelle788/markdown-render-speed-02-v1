// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node main.ts` (Node 22, TypeScript types stripped
// natively, so this file uses erasable syntax only). It reads the case
// list from $MAKEFUN_INPUT_DIR/cases.json (default /input), renders each
// case on its own with parse() from parse.js, and writes the HTML strings
// in order to $MAKEFUN_OUTPUT_DIR/html.json (default /output).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; markdown: string };

const cases = JSON.parse(
  readFileSync(join(inDir, 'cases.json'), 'utf8'),
) as Case[];

const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(rendered));
