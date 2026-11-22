/**
 * Obsidian 方言的行内语法（micromark 扩展 + mdast 构建扩展），叠加在 core 的 EHMD 行内语法之上：
 *
 * - `![[目标|参数]]` → mdast `obsEmbed`（`value` 为方括号之间的原文，`\|` 还原为 `|`）；
 *   规则与 core 的 `[[wikilink]]` 相同（不跨行、不含 `[`），必须先于图片的 `![` 识别；
 * - `^[行内脚注]` → mdast `obsInlineFootnote`（`value` 为方括号之间的原文；方括号可嵌套配对，不跨行）；
 * - `%%注释%%`（单行）→ mdast `obsComment`（`value` 为两组 `%%` 之间的原文）。跨行/跨段的注释由
 *   {@link ./extension.ts} 的 mdast 变换按源码合并。
 *
 * @module
 */
import type { Literal } from 'mdast';
import type { CompileContext, Extension as FromMarkdownExtension, Token as FmToken } from 'mdast-util-from-markdown';
import type { Code, Effects, Extension, State, TokenizeContext } from 'micromark-util-types';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    obsEmbed: 'obsEmbed';
    obsEmbedMarker: 'obsEmbedMarker';
    obsEmbedData: 'obsEmbedData';
    obsInlineFootnote: 'obsInlineFootnote';
    obsInlineFootnoteMarker: 'obsInlineFootnoteMarker';
    obsInlineFootnoteData: 'obsInlineFootnoteData';
    obsComment: 'obsComment';
    obsCommentMarker: 'obsCommentMarker';
    obsCommentData: 'obsCommentData';
  }
}

/** mdast 节点：`![[…]]`。`value` 为方括号之间的文本。 */
export interface ObsEmbedNode extends Literal {
  type: 'obsEmbed';
}
/** mdast 节点：`^[…]`。`value` 为方括号之间的原文（Markdown）。 */
export interface ObsInlineFootnoteNode extends Literal {
  type: 'obsInlineFootnote';
}
/** mdast 节点：单行 `%%…%%`。`value` 为两组 `%%` 之间的原文。 */
export interface ObsCommentNode extends Literal {
  type: 'obsComment';
}

declare module 'mdast' {
  interface PhrasingContentMap {
    obsEmbed: ObsEmbedNode;
    obsInlineFootnote: ObsInlineFootnoteNode;
    obsComment: ObsCommentNode;
  }
  interface RootContentMap {
    obsEmbed: ObsEmbedNode;
    obsInlineFootnote: ObsInlineFootnoteNode;
    obsComment: ObsCommentNode;
  }
}

const EXCLAMATION = 33;
const PERCENT = 37;
const LEFT_BRACKET = 91;
const BACKSLASH = 92;
const RIGHT_BRACKET = 93;
const CARET = 94;

const isBreak = (code: Code): boolean => code === null || code < 0;

/** `![[…]]`。 */
function embedSyntax(): Extension {
  const construct = { name: 'obsEmbed', tokenize };
  return { text: { [EXCLAMATION]: construct } };

  function tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    let size = 0;
    const start: State = (code) => {
      effects.enter('obsEmbed');
      effects.enter('obsEmbedMarker');
      effects.consume(code);
      return open1;
    };
    const open1: State = (code) => {
      if (code !== LEFT_BRACKET) return nok(code);
      effects.consume(code);
      return open2;
    };
    const open2: State = (code) => {
      if (code !== LEFT_BRACKET) return nok(code);
      effects.consume(code);
      effects.exit('obsEmbedMarker');
      effects.enter('obsEmbedData');
      return inside;
    };
    const inside: State = (code) => {
      if (isBreak(code) || code === LEFT_BRACKET) return nok(code);
      if (code === RIGHT_BRACKET) {
        if (size === 0) return nok(code);
        effects.exit('obsEmbedData');
        effects.enter('obsEmbedMarker');
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
      effects.exit('obsEmbedMarker');
      effects.exit('obsEmbed');
      return ok;
    };
    return start;
  }
}

/** `^[…]`（方括号嵌套配对）。 */
function inlineFootnoteSyntax(): Extension {
  const construct = { name: 'obsInlineFootnote', tokenize };
  return { text: { [CARET]: construct } };

  function tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    let depth = 0;
    let size = 0;
    const start: State = (code) => {
      effects.enter('obsInlineFootnote');
      effects.enter('obsInlineFootnoteMarker');
      effects.consume(code);
      return open;
    };
    const open: State = (code) => {
      if (code !== LEFT_BRACKET) return nok(code);
      effects.consume(code);
      effects.exit('obsInlineFootnoteMarker');
      effects.enter('obsInlineFootnoteData');
      return inside;
    };
    const inside: State = (code) => {
      if (isBreak(code)) return nok(code);
      if (code === RIGHT_BRACKET && depth === 0) {
        if (size === 0) return nok(code);
        effects.exit('obsInlineFootnoteData');
        effects.enter('obsInlineFootnoteMarker');
        effects.consume(code);
        effects.exit('obsInlineFootnoteMarker');
        effects.exit('obsInlineFootnote');
        return ok;
      }
      if (code === LEFT_BRACKET) depth++;
      else if (code === RIGHT_BRACKET) depth--;
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
    return start;
  }
}

/** 单行 `%%…%%`。 */
function commentSyntax(): Extension {
  const construct = { name: 'obsComment', tokenize };
  return { text: { [PERCENT]: construct } };

  function tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    let size = 0;
    const start: State = (code) => {
      effects.enter('obsComment');
      effects.enter('obsCommentMarker');
      effects.consume(code);
      return open;
    };
    const open: State = (code) => {
      if (code !== PERCENT) return nok(code);
      effects.consume(code);
      effects.exit('obsCommentMarker');
      return inside;
    };
    // 遇到 `%` 时先向前看：`%%` 结束注释，否则 `%` 属于数据
    const inside: State = (code) => {
      if (isBreak(code)) return nok(code);
      if (code === PERCENT) return effects.check({ tokenize: closeAhead, partial: true }, close, data)(code);
      return data(code);
    };
    const data: State = (code) => {
      if (size === 0) effects.enter('obsCommentData');
      effects.consume(code);
      size++;
      return inside;
    };
    const close: State = (code) => {
      if (size === 0) return nok(code);
      effects.exit('obsCommentData');
      effects.enter('obsCommentMarker');
      effects.consume(code);
      return closeSecond;
    };
    const closeSecond: State = (code) => {
      effects.consume(code);
      effects.exit('obsCommentMarker');
      effects.exit('obsComment');
      return ok;
    };
    return start;
  }

  function closeAhead(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const first: State = (code) => {
      effects.enter('obsCommentMarker');
      effects.consume(code);
      return second;
    };
    const second: State = (code) => {
      if (code !== PERCENT) return nok(code);
      effects.consume(code);
      effects.exit('obsCommentMarker');
      return ok;
    };
    return first;
  }
}

/** Obsidian 行内语法扩展（micromark）。 */
export function obsidianSyntax(): Extension[] {
  return [embedSyntax(), inlineFootnoteSyntax(), commentSyntax()];
}

type LiteralType = 'obsEmbed' | 'obsInlineFootnote' | 'obsComment';

function literal(type: LiteralType, unescapePipe: boolean): FromMarkdownExtension {
  return {
    enter: {
      [type](this: CompileContext, token: FmToken) {
        this.enter({ type, value: '' }, token);
      },
    },
    exit: {
      [`${type}Data`](this: CompileContext, token: FmToken) {
        const node = this.stack[this.stack.length - 1];
        if (node?.type === type) {
          const v = this.sliceSerialize(token);
          node.value = unescapePipe ? v.replace(/\\\|/g, '|') : v;
        }
      },
      [type](this: CompileContext, token: FmToken) {
        this.exit(token);
      },
    },
  };
}

/** Obsidian 行内语法的 mdast 构建扩展。 */
export function obsidianFromMarkdown(): FromMarkdownExtension[] {
  return [literal('obsEmbed', true), literal('obsInlineFootnote', false), literal('obsComment', false)];
}
