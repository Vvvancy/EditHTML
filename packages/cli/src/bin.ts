#!/usr/bin/env node
import { ehmdMarkdown, run } from './index.js';

const code = await run(process.argv.slice(2), {
  io: { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
  markdown: ehmdMarkdown,
});
process.exitCode = code;
