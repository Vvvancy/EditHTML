/**
 * HTML 字符引用（实体）解码：数字实体 + 常用命名实体表；未知命名实体按字面保留（01 §6.1）。
 *
 * @module
 */
import type { WarnFn } from './warnings.js';

/** 常用命名实体（不含 `&` 与 `;`）→ 字符。 */
export const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200c',
  zwj: '\u200d',
  lrm: '\u200e',
  rlm: '\u200f',
  shy: '\u00ad',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  lsaquo: '‹',
  rsaquo: '›',
  bull: '•',
  middot: '·',
  prime: '′',
  Prime: '″',
  dagger: '†',
  Dagger: '‡',
  permil: '‰',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  micro: 'µ',
  para: '¶',
  sect: '§',
  cent: '¢',
  pound: '£',
  yen: '¥',
  euro: '€',
  curren: '¤',
  iexcl: '¡',
  iquest: '¿',
  ordf: 'ª',
  ordm: 'º',
  not: '¬',
  macr: '¯',
  acute: '´',
  cedil: '¸',
  uml: '¨',
  brvbar: '¦',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup1: '¹',
  sup2: '²',
  sup3: '³',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  lArr: '⇐',
  rArr: '⇒',
  hArr: '⇔',
  crarr: '↵',
  minus: '−',
  le: '≤',
  ge: '≥',
  ne: '≠',
  asymp: '≈',
  equiv: '≡',
  infin: '∞',
  sum: '∑',
  prod: '∏',
  radic: '√',
  part: '∂',
  nabla: '∇',
  isin: '∈',
  notin: '∉',
  forall: '∀',
  exist: '∃',
  empty: '∅',
  cap: '∩',
  cup: '∪',
  sub: '⊂',
  sup: '⊃',
  sube: '⊆',
  supe: '⊇',
  and: '∧',
  or: '∨',
  int: '∫',
  there4: '∴',
  sim: '∼',
  prop: '∝',
  ang: '∠',
  perp: '⊥',
  sdot: '⋅',
  lowast: '∗',
  oplus: '⊕',
  otimes: '⊗',
  loz: '◊',
  spades: '♠',
  clubs: '♣',
  hearts: '♥',
  diams: '♦',
  check: '✓',
  cross: '✗',
  star: '☆',
  starf: '★',
  Alpha: 'Α',
  Beta: 'Β',
  Gamma: 'Γ',
  Delta: 'Δ',
  Epsilon: 'Ε',
  Zeta: 'Ζ',
  Eta: 'Η',
  Theta: 'Θ',
  Iota: 'Ι',
  Kappa: 'Κ',
  Lambda: 'Λ',
  Mu: 'Μ',
  Nu: 'Ν',
  Xi: 'Ξ',
  Omicron: 'Ο',
  Pi: 'Π',
  Rho: 'Ρ',
  Sigma: 'Σ',
  Tau: 'Τ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Chi: 'Χ',
  Psi: 'Ψ',
  Omega: 'Ω',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  omicron: 'ο',
  pi: 'π',
  rho: 'ρ',
  sigmaf: 'ς',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  thetasym: 'ϑ',
  piv: 'ϖ',
  Agrave: 'À',
  Aacute: 'Á',
  Acirc: 'Â',
  Atilde: 'Ã',
  Auml: 'Ä',
  Aring: 'Å',
  AElig: 'Æ',
  Ccedil: 'Ç',
  Egrave: 'È',
  Eacute: 'É',
  Ecirc: 'Ê',
  Euml: 'Ë',
  Igrave: 'Ì',
  Iacute: 'Í',
  Icirc: 'Î',
  Iuml: 'Ï',
  Ntilde: 'Ñ',
  Ograve: 'Ò',
  Oacute: 'Ó',
  Ocirc: 'Ô',
  Otilde: 'Õ',
  Ouml: 'Ö',
  Oslash: 'Ø',
  Ugrave: 'Ù',
  Uacute: 'Ú',
  Ucirc: 'Û',
  Uuml: 'Ü',
  Yacute: 'Ý',
  szlig: 'ß',
  agrave: 'à',
  aacute: 'á',
  acirc: 'â',
  atilde: 'ã',
  auml: 'ä',
  aring: 'å',
  aelig: 'æ',
  ccedil: 'ç',
  egrave: 'è',
  eacute: 'é',
  ecirc: 'ê',
  euml: 'ë',
  igrave: 'ì',
  iacute: 'í',
  icirc: 'î',
  iuml: 'ï',
  ntilde: 'ñ',
  ograve: 'ò',
  oacute: 'ó',
  ocirc: 'ô',
  otilde: 'õ',
  ouml: 'ö',
  oslash: 'ø',
  ugrave: 'ù',
  uacute: 'ú',
  ucirc: 'û',
  uuml: 'ü',
  yacute: 'ý',
  yuml: 'ÿ',
  OElig: 'Œ',
  oelig: 'œ',
  Scaron: 'Š',
  scaron: 'š',
  Yuml: 'Ÿ',
  fnof: 'ƒ',
  circ: 'ˆ',
  tilde: '˜',
};

/** HTML 允许省略分号的旧式命名实体（取常用子集）。 */
const LEGACY_NO_SEMI = ['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg'];

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

const isAlnum = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

function codePointToString(cp: number): string {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
  return String.fromCodePoint(cp);
}

/**
 * 解码字符串中的字符引用。
 *
 * - 数字实体 `&#123;` / `&#x1F600;`（分号可省略）；0、代理区与越界码点解码为 U+FFFD；
 * - 命名实体须以 `;` 结尾且在 {@link NAMED_ENTITIES} 中；少数旧式实体（`&amp` 等）允许省略分号
 *   （在属性值中，若其后紧跟字母数字或 `=` 则按字面保留，与 HTML 规范一致）；
 * - 未知命名实体（`&foo;`）按字面保留并告警 `unknown-entity`；裸 `&` 按字面保留。
 *
 * @param s 原始文本（未解码）。
 * @param inAttr 是否为属性值。
 * @param offset `s` 在源文档中的起始偏移，用于告警定位。
 * @param warn 可选告警回调。
 */
export function decodeEntities(s: string, inAttr = false, offset = 0, warn?: WarnFn): string {
  let amp = s.indexOf('&');
  if (amp < 0) return s;
  let out = '';
  let last = 0;
  const n = s.length;
  while (amp >= 0) {
    let i = amp + 1;
    let replacement: string | null = null;
    let end = i;
    if (i < n && s.charCodeAt(i) === 0x23 /* # */) {
      i++;
      let hex = false;
      if (i < n && (s.charCodeAt(i) | 0x20) === 0x78 /* x */) {
        hex = true;
        i++;
      }
      const digitsStart = i;
      let cp = 0;
      for (; i < n; i++) {
        const c = s.charCodeAt(i);
        let d: number;
        if (c >= 0x30 && c <= 0x39) d = c - 0x30;
        else if (hex && (c | 0x20) >= 0x61 && (c | 0x20) <= 0x66) d = (c | 0x20) - 0x61 + 10;
        else break;
        cp = cp * (hex ? 16 : 10) + d;
        if (cp > 0x10ffff) cp = 0x110000; // 防溢出，统一视为越界
      }
      if (i > digitsStart) {
        replacement = codePointToString(cp);
        end = i < n && s.charCodeAt(i) === 0x3b /* ; */ ? i + 1 : i;
      }
    } else {
      const nameStart = i;
      while (i < n && isAlnum(s.charCodeAt(i))) i++;
      const name = s.slice(nameStart, i);
      if (name !== '') {
        if (i < n && s.charCodeAt(i) === 0x3b) {
          if (hasOwn(NAMED_ENTITIES, name)) {
            replacement = NAMED_ENTITIES[name] as string;
            end = i + 1;
          } else {
            warn?.('unknown-entity', `unknown named entity &${name}; kept literally`, offset + amp);
          }
        } else {
          for (const legacy of LEGACY_NO_SEMI) {
            if (!name.startsWith(legacy)) continue;
            const after = nameStart + legacy.length;
            if (inAttr && after < n && (isAlnum(s.charCodeAt(after)) || s.charCodeAt(after) === 0x3d)) break;
            replacement = NAMED_ENTITIES[legacy] as string;
            end = after;
            break;
          }
        }
      }
    }
    if (replacement !== null) {
      out += s.slice(last, amp) + replacement;
      last = end;
      amp = s.indexOf('&', end);
    } else {
      amp = s.indexOf('&', amp + 1);
    }
  }
  return out + s.slice(last);
}
