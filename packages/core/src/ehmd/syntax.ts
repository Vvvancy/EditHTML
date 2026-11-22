/**
 * EHMD 的 micromark 语法扩展与对应的 mdast-util-from-markdown 扩展（行内）：
 *
 * - `==高亮==` → mdast `ehMark`（对应 mark 标记）；规则与 GFM 删除线（`~~`）相同，只接受两个 `=`；
 * - `[[目标|别名]]` → mdast `ehWikiLink`（`value` 为方括号内原文，`\|` 还原为 `|`）；
 * - `#标签` → mdast `ehTag`（`value` 为含 `#` 的原文）。
 *
 * 块级的指令（`:::name`）与 frontmatter 不走 micromark，而由 {@link ./prepass.ts} 的行扫描处理。
 *
 * @module
 */
import type { Extension as FromMarkdownExtension, CompileContext, Token as FmToken } from 'mdast-util-from-markdown';
import type { Literal, Parent, PhrasingContent } from 'mdast';
import { splice } from 'micromark-util-chunked';
import { classifyCharacter } from 'micromark-util-classify-character';
import { resolveAll } from 'micromark-util-resolve-all';
import type { Code, Effects, Event, Extension, State, Token, TokenizeContext } from 'micromark-util-types';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    ehMark: 'ehMark';
    ehMarkSequence: 'ehMarkSequence';
    ehMarkSequenceTemporary: 'ehMarkSequenceTemporary';
    ehMarkText: 'ehMarkText';
    ehWikiLink: 'ehWikiLink';
    ehWikiLinkMarker: 'ehWikiLinkMarker';
    ehWikiLinkData: 'ehWikiLinkData';
    ehTag: 'ehTag';
    ehTagMarker: 'ehTagMarker';
    ehTagData: 'ehTagData';
  }
}

/** mdast 节点：`==高亮==`。 */
export interface EhMarkNode extends Parent {
  type: 'ehMark';
  children: PhrasingContent[];
}
/** mdast 节点：`[[…]]`。`value` 为方括号之间的文本。 */
export interface EhWikiLinkNode extends Literal {
  type: 'ehWikiLink';
}
/** mdast 节点：`#tag`。`value` 含前导 `#`。 */
export interface EhTagNode extends Literal {
  type: 'ehTag';
}

declare module 'mdast' {
  interface PhrasingContentMap {
    ehMark: EhMarkNode;
    ehWikiLink: EhWikiLinkNode;
    ehTag: EhTagNode;
  }
  interface RootContentMap {
    ehMark: EhMarkNode;
    ehWikiLink: EhWikiLinkNode;
    ehTag: EhTagNode;
  }
}

const EQUALS = 61;
const LEFT_BRACKET = 91;
const RIGHT_BRACKET = 93;
const BACKSLASH = 92;
const NUMBER_SIGN = 35;

/**
 * 标签字符（逐 UTF-16 码元判断）：字母、数字、组合符号、`_`、`-`、`/`。
 * 代理对码元不算标签字符（含 emoji 的标签不识别）。序列化器使用同一判定。
 */
export function isTagChar(code: number | null): boolean {
  if (code === null || code < 0) return false;
  return /[\p{L}\p{N}\p{M}_/-]/u.test(String.fromCharCode(code));
}

/** `#` 之后的文本是否构成标签（至少一个非数字字符）。 */
export function isTagBody(body: string): boolean {
  if (body === '') return false;
  let nonDigit = false;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (!isTagChar(c)) return false;
    if (c < 48 || c > 57) nonDigit = true;
  }
  return nonDigit;
}

// ───────────────────────────── ==mark== ─────────────────────────────

/** `==mark==` 语法（改写自 micromark-extension-gfm-strikethrough，只接受双 `=`）。 */
function markSyntax(): Extension {
  const tokenizer = { name: 'ehMark', tokenize: tokenizeMark, resolveAll: resolveAllMark };
  return {
    text: { [EQUALS]: tokenizer },
    insideSpan: { null: [tokenizer] },
    attentionMarkers: { null: [EQUALS] },
  };

  function resolveAllMark(events: Event[], context: TokenizeContext): Event[] {
    let index = -1;
    while (++index < events.length) {
      const ev = events[index] as Event;
      if (ev[0] === 'enter' && ev[1].type === 'ehMarkSequenceTemporary' && ev[1]._close) {
        let open = index;
        while (open--) {
          const op = events[open] as Event;
          if (op[0] === 'exit' && op[1].type === 'ehMarkSequenceTemporary' && op[1]._open) {
            ev[1].type = 'ehMarkSequence';
            op[1].type = 'ehMarkSequence';
            const mark: Token = { type: 'ehMark', start: { ...op[1].start }, end: { ...ev[1].end } };
            const text: Token = { type: 'ehMarkText', start: { ...op[1].end }, end: { ...ev[1].start } };
            const next: Event[] = [
              ['enter', mark, context],
              ['enter', op[1], context],
              ['exit', op[1], context],
              ['enter', text, context],
            ];
            const insideSpan = context.parser.constructs.insideSpan.null;
            if (insideSpan)
              splice(next, next.length, 0, resolveAll(insideSpan, events.slice(open + 1, index), context));
            splice(next, next.length, 0, [
              ['exit', text, context],
              ['enter', ev[1], context],
              ['exit', ev[1], context],
              ['exit', mark, context],
            ]);
            splice(events, open - 1, index - open + 3, next);
            index = open + next.length - 2;
            break;
          }
        }
      }
    }
    for (const ev of events) if (ev[1].type === 'ehMarkSequenceTemporary') ev[1].type = 'data';
    return events;
  }

  function tokenizeMark(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const previous = this.previous;
    const events = this.events;
    let size = 0;
    const start: State = (code) => {
      const last = events[events.length - 1];
      if (previous === EQUALS && last?.[1].type !== 'characterEscape') return nok(code);
      effects.enter('ehMarkSequenceTemporary');
      return more(code);
    };
    const more: State = (code) => {
      const before = classifyCharacter(previous);
      if (code === EQUALS) {
        if (size > 1) return nok(code);
        effects.consume(code);
        size++;
        return more;
      }
      if (size < 2) return nok(code);
      const token = effects.exit('ehMarkSequenceTemporary');
      const after = classifyCharacter(code);
      token._open = !after || (after === 2 && Boolean(before));
      token._close = !before || (before === 2 && Boolean(after));
      return ok(code);
    };
    return start;
  }
}

// ───────────────────────────── [[wikilink]] ─────────────────────────────

function wikiLinkSyntax(): Extension {
  const construct = { name: 'ehWikiLink', tokenize: tokenizeWikiLink };
  return { text: { [LEFT_BRACKET]: construct } };

  function tokenizeWikiLink(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    let size = 0;
    const isBreak = (code: Code): boolean => code === null || code < 0;
    const start: State = (code) => {
      effects.enter('ehWikiLink');
      effects.enter('ehWikiLinkMarker');
      effects.consume(code);
      return second;
    };
    const second: State = (code) => {
      if (code !== LEFT_BRACKET) return nok(code);
      effects.consume(code);
      effects.exit('ehWikiLinkMarker');
      effects.enter('ehWikiLinkData');
      return inside;
    };
    const inside: State = (code) => {
      if (isBreak(code) || code === LEFT_BRACKET) return nok(code);
      if (code === RIGHT_BRACKET) {
        if (size === 0) return nok(code);
        effects.exit('ehWikiLinkData');
        effects.enter('ehWikiLinkMarker');
        effects.consume(code);
        return close;
      }
      effects.consume(code);
      size++;
      return code === BACKSLASH ? escape : inside;
    };
    const escape: State = (code) => {
      if (isBreak(code)) return nok(code);
      effects.consume(code);
      size++;
      return inside;
    };
    const close: State = (code) => {
      if (code !== RIGHT_BRACKET) return nok(code);
      effects.consume(code);
      effects.exit('ehWikiLinkMarker');
      effects.exit('ehWikiLink');
      return ok;
    };
    return start;
  }
}

// ───────────────────────────── #tag ─────────────────────────────

function tagSyntax(): Extension {
  const construct = { name: 'ehTag', tokenize: tokenizeTag };
  return { text: { [NUMBER_SIGN]: construct } };

  function tokenizeTag(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const previous = this.previous;
    let size = 0;
    let nonDigit = false;
    const start: State = (code) => {
      if (isTagChar(previous) || previous === NUMBER_SIGN) return nok(code);
      effects.enter('ehTag');
      effects.enter('ehTagMarker');
      effects.consume(code);
      effects.exit('ehTagMarker');
      return first;
    };
    const first: State = (code) => {
      if (!isTagChar(code)) return nok(code);
      effects.enter('ehTagData');
      return inside(code);
    };
    const inside: State = (code) => {
      if (code !== null && isTagChar(code)) {
        if (code < 48 || code > 57) nonDigit = true;
        effects.consume(code);
        size++;
        return inside;
      }
      if (size === 0 || !nonDigit) return nok(code);
      effects.exit('ehTagData');
      effects.exit('ehTag');
      return ok(code);
    };
    return start;
  }
}

// ───────────────────────────── 组合 ─────────────────────────────

/** EHMD 行内语法扩展（micromark）。 */
export function ehmdSyntax(): Extension[] {
  return [markSyntax(), wikiLinkSyntax(), tagSyntax()];
}

/** EHMD 行内语法的 mdast 构建扩展（mdast-util-from-markdown）。 */
export function ehmdFromMarkdown(): FromMarkdownExtension {
  return {
    canContainEols: ['ehMark'],
    enter: {
      ehMark(this: CompileContext, token: FmToken) {
        this.enter({ type: 'ehMark', children: [] }, token);
      },
      ehWikiLink(this: CompileContext, token: FmToken) {
        this.enter({ type: 'ehWikiLink', value: '' }, token);
      },
      ehTag(this: CompileContext, token: FmToken) {
        this.enter({ type: 'ehTag', value: '' }, token);
      },
    },
    exit: {
      ehMark(this: CompileContext, token: FmToken) {
        this.exit(token);
      },
      ehWikiLinkData(this: CompileContext, token: FmToken) {
        const node = this.stack[this.stack.length - 1];
        if (node?.type === 'ehWikiLink') node.value = this.sliceSerialize(token).replace(/\\\|/g, '|');
      },
      ehWikiLink(this: CompileContext, token: FmToken) {
        this.exit(token);
      },
      ehTag(this: CompileContext, token: FmToken) {
        const node = this.stack[this.stack.length - 1];
        if (node?.type === 'ehTag') node.value = this.sliceSerialize(token);
        this.exit(token);
      },
    },
  };
}
