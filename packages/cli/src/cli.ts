/**
 * `eh` 命令行：`convert` / `check` / `fmt`（任务 T1.8）。
 *
 * 原则（05 #10）：转换**从不覆盖源文件**；目标文件已存在时需要 `--force`。
 *
 * @module
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SPEC_VERSION, parse, serialize, validateDoc } from '@edithtml/core';
import {
  detectFormat,
  extensionFor,
  readDoc,
  writeDoc,
  type Diagnostic,
  type Format,
  type MarkdownAdapter,
  type MarkdownFlavor,
} from './formats.js';

/** 输出通道（便于测试捕获）。 */
export interface Io {
  out(text: string): void;
  err(text: string): void;
}

/** CLI 运行环境。 */
export interface CliEnv {
  readonly io: Io;
  /** Markdown 读写实现，默认来自 `@edithtml/importer`。 */
  readonly markdown: MarkdownAdapter;
  /** 相对路径的基准目录，默认 `process.cwd()`。 */
  readonly cwd?: string;
}

/** CLI 帮助文本。 */
export function helpText(): string {
  return `eh — EditHTML command line (spec v${SPEC_VERSION})

Usage:
  eh convert <input...> [-o <out>] [--to ehtml|md|ehmd] [--flavor obsidian|commonmark] [--force]
      Convert files or whole folders. Default target: .md → .eh.html, .eh.html/.html → .md.
      Source files are never overwritten; existing targets need --force.
  eh check <file...> [--strict]
      Parse and validate; print warnings as file:line:col. Exit 1 on invalid docs
      (or on any warning with --strict).
  eh fmt <file...> [--check]
      Rewrite .eh.html files in canonical form (01 §6). With --check, only report
      files that are not canonical and exit 1 if any.

Options:
  -h, --help       Show this help
  -v, --version    Show the spec version
`;
}

const INPUT_EXT = /\.(eh\.html|ehtml|html?|md|markdown|ehmd)$/i;

/** 展开输入：文件原样返回，目录递归收集受支持的文件（跳过以 `.` 开头的目录，如 `.obsidian`、`.git`）。 */
async function expandInputs(inputs: readonly string[], cwd: string): Promise<{ root: string; file: string }[]> {
  const out: { root: string; file: string }[] = [];
  for (const input of inputs) {
    const abs = resolve(cwd, input);
    const s = await stat(abs);
    if (s.isDirectory()) {
      const walk = async (dir: string): Promise<void> => {
        const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const p = join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else if (INPUT_EXT.test(e.name)) out.push({ root: abs, file: p });
        }
      };
      await walk(abs);
    } else out.push({ root: dirname(abs), file: abs });
  }
  return out;
}

function stripExt(path: string): string {
  return path.replace(INPUT_EXT, '');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function formatDiag(file: string, d: Diagnostic): string {
  return `${file}:${d.line}:${d.column}: ${d.code}: ${d.message}`;
}

function defaultTarget(from: Format): Format {
  return from === 'md' || from === 'ehmd' ? 'ehtml' : 'md';
}

async function cmdConvert(args: string[], env: CliEnv, cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      to: { type: 'string' },
      flavor: { type: 'string', default: 'obsidian' },
      force: { type: 'boolean', default: false },
    },
  });
  if (positionals.length === 0) {
    env.io.err('eh convert: missing input\n');
    return 2;
  }
  const to = values.to as Format | undefined;
  if (to !== undefined && !['ehtml', 'md', 'ehmd'].includes(to)) {
    env.io.err(`eh convert: unknown --to ${to}\n`);
    return 2;
  }
  const flavor = values.flavor as MarkdownFlavor;
  if (flavor !== 'obsidian' && flavor !== 'commonmark') {
    env.io.err(`eh convert: unknown --flavor ${String(flavor)}\n`);
    return 2;
  }
  const files = await expandInputs(positionals, cwd);
  const outArg = values.out !== undefined ? resolve(cwd, values.out) : undefined;
  const single =
    files.length === 1 &&
    positionals.length === 1 &&
    !(await stat(resolve(cwd, positionals[0] as string))).isDirectory();

  let failures = 0;
  let converted = 0;
  for (const { root, file } of files) {
    const src = await readFile(file, 'utf8');
    const from = detectFormat(file, src);
    if (from === null) continue;
    const target = to ?? defaultTarget(from);
    let dest: string;
    if (outArg !== undefined && single) dest = outArg;
    else if (outArg !== undefined) dest = join(outArg, stripExt(relative(root, file)) + extensionFor(target));
    else dest = stripExt(file) + extensionFor(target);
    const rel = relative(cwd, file) || file;
    if (resolve(dest) === resolve(file)) {
      env.io.err(`${rel}: refusing to overwrite the source file (choose -o or --to)\n`);
      failures++;
      continue;
    }
    if (!values.force && (await exists(dest))) {
      env.io.err(`${relative(cwd, dest)}: already exists (use --force to overwrite)\n`);
      failures++;
      continue;
    }
    try {
      const { doc, diagnostics } = readDoc(src, from, env.markdown);
      for (const d of diagnostics) env.io.err(formatDiag(rel, d) + '\n');
      const text = writeDoc(doc, target, env.markdown, flavor);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, text, 'utf8');
      env.io.out(`${rel} → ${relative(cwd, dest)}\n`);
      converted++;
    } catch (e) {
      env.io.err(`${rel}: ${e instanceof Error ? e.message : String(e)}\n`);
      failures++;
    }
  }
  env.io.out(`converted ${converted} file(s)${failures ? `, ${failures} failed` : ''}\n`);
  return failures ? 1 : 0;
}

async function cmdCheck(args: string[], env: CliEnv, cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { strict: { type: 'boolean', default: false } },
  });
  if (positionals.length === 0) {
    env.io.err('eh check: missing input\n');
    return 2;
  }
  let invalid = 0;
  let warned = 0;
  for (const { file } of await expandInputs(positionals, cwd)) {
    const src = await readFile(file, 'utf8');
    const format = detectFormat(file, src);
    if (format === null) continue;
    const rel = relative(cwd, file) || file;
    const { doc, diagnostics } = readDoc(src, format, env.markdown);
    for (const d of diagnostics) env.io.out(formatDiag(rel, d) + '\n');
    if (diagnostics.length) warned++;
    const problems = validateDoc(doc);
    for (const p of problems) env.io.out(`${rel}: invalid: ${p}\n`);
    if (problems.length) invalid++;
  }
  return invalid || (values.strict && warned) ? 1 : 0;
}

async function cmdFmt(args: string[], env: CliEnv, cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { check: { type: 'boolean', default: false } },
  });
  if (positionals.length === 0) {
    env.io.err('eh fmt: missing input\n');
    return 2;
  }
  let changed = 0;
  for (const { file } of await expandInputs(positionals, cwd)) {
    const src = await readFile(file, 'utf8');
    if (detectFormat(file, src) !== 'ehtml') continue; // 只格式化 .ehtml；普通 .html 需先 convert
    const out = serialize(parse(src).doc);
    if (out === src) continue;
    changed++;
    const rel = relative(cwd, file) || file;
    if (values.check) env.io.out(`${rel}: not canonical\n`);
    else {
      await writeFile(file, out, 'utf8');
      env.io.out(`${rel}: formatted\n`);
    }
  }
  return values.check && changed ? 1 : 0;
}

/** 运行 CLI，返回退出码（0 成功，1 失败，2 用法错误）。 */
export async function run(argv: readonly string[], env: CliEnv): Promise<number> {
  const cwd = env.cwd ?? process.cwd();
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'convert':
        return await cmdConvert(rest, env, cwd);
      case 'check':
        return await cmdCheck(rest, env, cwd);
      case 'fmt':
        return await cmdFmt(rest, env, cwd);
      case '-v':
      case '--version':
        env.io.out(`${SPEC_VERSION}\n`);
        return 0;
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        env.io.out(helpText());
        return 0;
      default:
        env.io.err(`eh: unknown command ${cmd}\n\n${helpText()}`);
        return 2;
    }
  } catch (e) {
    env.io.err(`eh ${cmd}: ${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof TypeError ? 2 : 1;
  }
}
