/**
 * 块级预扫描：frontmatter 与指令块（`:::name …` / `::name …`）。
 *
 * 指令不走 micromark：按行扫描，把顶格的指令块整体替换为一行占位 HTML 注释
 * （`<!--ehmd:N:nonce-->`，前面补一个空行，保证它独立成块），其余 Markdown 一次交给 micromark 解析，
 * 转换时再把占位节点换回指令。规则（见 docs/01 §7"实现约定"）：
 *
 * - 开始行：顶格 `:{3,}`，可选空白，指令名 `[A-Za-z][A-Za-z0-9_-]*`，其后是标签和/或属性块；
 * - 结束行：冒号数**恰好相同**、其后只有空白的行；没有结束行时延伸到文本末尾（告警）；
 * - 指令体按原文保留（叶子组件是 YAML，容器是递归解析的 EHMD），所以外层冒号必须多于体内任何顶格冒号串；
 * - 只在围栏代码块之外识别开始行（跟踪顶格 0–3 空格缩进的 ``` / ~~~ 围栏）；
 * - `::name …`（恰好两个冒号）是单行指令，等价于体为空的 `:::name …`。
 *
 * @module
 */

/** 扫描得到的指令。 */
export interface RawDirective {
  /** 冒号数（单行指令为 2）。 */
  readonly colons: number;
  readonly name: string;
  /** 指令名之后、到行尾的原文（标签与属性块）。 */
  readonly rest: string;
  /** 指令体原文（不含首尾行）。 */
  readonly body: string;
  /** 开始行在扫描文本中的偏移。 */
  readonly offset: number;
  /** 指令体第一行的偏移。 */
  readonly bodyOffset: number;
  /** 整个指令块的原文（含首尾行）。 */
  readonly raw: string;
  /** 是否找到结束行。 */
  readonly closed: boolean;
}

/** 预扫描结果。 */
export interface ScanResult {
  /** 指令替换为占位注释后的 Markdown。 */
  readonly markdown: string;
  readonly directives: RawDirective[];
  /** 占位注释的匹配：`<!--ehmd:N:nonce-->`。 */
  readonly placeholder: RegExp;
  /** 偏移映射：`markdown` 中的偏移 → 扫描文本中的偏移。 */
  mapOffset(offset: number): number;
}

const OPEN_RE = /^(:{2,})[ \t]*([A-Za-z][A-Za-z0-9_-]*)(.*)$/;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** 拆出 frontmatter：`---` 开头、到下一个 `---` 或 `...` 行为止。 */
export function splitFrontmatter(src: string): { yaml: string | null; rest: string; restOffset: number } {
  if (!/^---[ \t]*(\n|$)/.test(src)) return { yaml: null, rest: src, restOffset: 0 };
  const firstEnd = src.indexOf('\n');
  if (firstEnd < 0) return { yaml: null, rest: src, restOffset: 0 };
  let pos = firstEnd + 1;
  while (pos <= src.length) {
    let end = src.indexOf('\n', pos);
    if (end < 0) end = src.length;
    const line = src.slice(pos, end);
    if (/^(---|\.\.\.)[ \t]*$/.test(line)) {
      const restOffset = Math.min(end + 1, src.length);
      return {
        yaml: src.slice(firstEnd + 1, pos === firstEnd + 1 ? pos : pos - 1),
        rest: src.slice(restOffset),
        restOffset,
      };
    }
    pos = end + 1;
  }
  return { yaml: null, rest: src, restOffset: 0 };
}

/** 扫描指令块。`text` 必须已统一为 `\n` 换行。 */
export function scanDirectives(text: string): ScanResult {
  const lines = text.split('\n');
  const offsets: number[] = [];
  {
    let o = 0;
    for (const l of lines) {
      offsets.push(o);
      o += l.length + 1;
    }
  }
  let nonce = 0;
  while (text.includes(`<!--ehmd:`) && text.includes(`:${nonce.toString(36)}-->`)) nonce++;
  const tag = nonce.toString(36);
  const directives: RawDirective[] = [];
  const out: string[] = [];
  // [输出偏移, 源偏移] 断点
  const map: [number, number][] = [[0, 0]];
  let outLen = 0;
  const push = (s: string, srcOffset: number): void => {
    map.push([outLen, srcOffset]);
    out.push(s);
    outLen += s.length + 1;
  };

  let fence: { char: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const at = offsets[i] as number;
    if (fence) {
      const m = FENCE_RE.exec(line);
      if (
        m &&
        (m[2] as string)[0] === fence.char &&
        (m[2] as string).length >= fence.len &&
        /^[ \t]*$/.test(m[3] ?? '')
      )
        fence = null;
      push(line, at);
      continue;
    }
    const fm = FENCE_RE.exec(line);
    if (fm && !((fm[2] as string)[0] === '`' && (fm[3] ?? '').includes('`'))) {
      fence = { char: (fm[2] as string)[0] as string, len: (fm[2] as string).length };
      push(line, at);
      continue;
    }
    const om = OPEN_RE.exec(line);
    if (!om) {
      push(line, at);
      continue;
    }
    const colons = (om[1] as string).length;
    const name = om[2] as string;
    const rest = om[3] as string;
    let j = i + 1;
    let closed = colons === 2;
    if (colons > 2) {
      const closeRe = new RegExp(`^:{${colons}}[ \\t]*$`);
      while (j < lines.length && !closeRe.test(lines[j] as string)) j++;
      closed = j < lines.length;
    } else j = i;
    const bodyLines = colons === 2 ? [] : lines.slice(i + 1, Math.min(j, lines.length));
    const endLine = Math.min(j, lines.length - 1);
    const rawEnd = (offsets[endLine] as number) + (lines[endLine] as string).length;
    directives.push({
      colons,
      name,
      rest,
      body: bodyLines.join('\n'),
      offset: at,
      bodyOffset: i + 1 < lines.length ? (offsets[i + 1] as number) : text.length,
      raw: text.slice(at, rawEnd),
      closed,
    });
    push('', at);
    push(`<!--ehmd:${directives.length - 1}:${tag}-->`, at);
    push('', at);
    i = colons === 2 ? i : j;
  }
  const markdown = out.join('\n');
  const placeholder = new RegExp(`^<!--ehmd:(\\d+):${tag}-->$`);
  return {
    markdown,
    directives,
    placeholder,
    mapOffset(offset) {
      let lo = 0;
      let hi = map.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((map[mid] as [number, number])[0] <= offset) lo = mid;
        else hi = mid - 1;
      }
      const [o, s] = map[lo] as [number, number];
      return s + Math.max(0, offset - o);
    },
  };
}

/** 指令体中顶格冒号串（≥3）的最大长度；用于选择外层冒号数。 */
export function maxColonRun(body: string): number {
  let max = 0;
  for (const m of body.matchAll(/^(:{3,})/gm)) max = Math.max(max, (m[1] as string).length);
  return max;
}
