/**
 * 解析前的等长改写（不改变任何偏移，源码区间可以直接切原文）。
 *
 * 目前只有一条：Obsidian 允许把块 ID 写在块公式的结束行上（`$$ ^eq-1`），而 CommonMark 的数学扩展只认
 * 后面只有空白的 `$$` 为结束行，否则公式会一直延伸到文末。这里把结束行中 `$$` 之后的第一个空白字符换成
 * 换行：`$$ ^eq-1` → `$$⏎^eq-1`，单独一行的 `^eq-1` 再由 core 附着到该公式块上。
 *
 * @module
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const MATH_OPEN_RE = /^ {0,3}\$\$/;
const MATH_CLOSE_ID_RE = /^( {0,3}\$\$+)[ \t]+\^[A-Za-z0-9_-]+[ \t]*$/;
const MATH_CLOSE_RE = /^ {0,3}\$\$+[ \t]*$/;

/** 把 `$$ ^id` 结束行改写为两行（等长）。`text` 必须已统一为 `\n` 换行。 */
export function preprocessMarkdown(text: string): string {
  if (!text.includes('$$')) return text;
  const lines = text.split('\n');
  let fence: { char: string; len: number } | null = null;
  let math = false;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (fence) {
      const m = FENCE_RE.exec(line);
      if (
        m &&
        (m[1] as string)[0] === fence.char &&
        (m[1] as string).length >= fence.len &&
        /^[ \t]*$/.test(m[2] ?? '')
      )
        fence = null;
      continue;
    }
    if (math) {
      const m = MATH_CLOSE_ID_RE.exec(line);
      if (m) {
        const at = (m[1] as string).length;
        lines[i] = `${line.slice(0, at)}\n${line.slice(at + 1)}`;
        changed = true;
        math = false;
      } else if (MATH_CLOSE_RE.test(line)) math = false;
      continue;
    }
    const fm = FENCE_RE.exec(line);
    if (fm) {
      fence = { char: (fm[1] as string)[0] as string, len: (fm[1] as string).length };
      continue;
    }
    // 开始行：`$$` 之后没有第二个 `$$`（同一行写完的 `$$…$$` 是行内公式）
    if (MATH_OPEN_RE.test(line) && !/\$\$/.test(line.trimStart().slice(2))) math = true;
  }
  return changed ? lines.join('\n') : text;
}
