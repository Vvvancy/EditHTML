// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"handleDisabledFileLoadingAsSuccess":true,"disableJavaScriptEvaluation":true,"disableCSSFileLoading":true,"disableIframePageLoading":true}}
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GENERATED_ATTR, GENERATED_TIP, STYLE_ATTR, mountPreserve, type PreserveMount } from './mount.js';
import { buildSpanIndex, type SpanNode } from './span-index.js';
import { loadSpec } from '../testing/spec-dom.js';

const FIXTURES = join(import.meta.dirname, '../../../../tests/fixtures/html/');
const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.html'))
  .map((f) => [f, readFileSync(FIXTURES + f, 'utf8')] as const);
const fixture = (name: string): string => {
  const hit = fixtures.find(([f]) => f === name);
  if (!hit) throw new Error(`no fixture ${name}`);
  return hit[1];
};

const HTML_NS = 'http://www.w3.org/1999/xhtml';
/** happy-dom 会把 `o:p` 拆成前缀 + localName `p`，用小写 tagName 才与 parse5 一致。 */
const nameOf = (el: Element): string => (el.namespaceURI === HTML_NS ? el.tagName.toLowerCase() : el.localName);

function kids(n: Node): Node[] {
  const host = n.nodeType === 1 && nameOf(n as Element) === 'template' ? (n as HTMLTemplateElement).content : n;
  return [...host.childNodes].filter((c) => c.nodeType !== 10);
}

function* walk(n: Node): Generator<Node> {
  yield n;
  for (const c of kids(n)) yield* walk(c);
}

const shallowEq = (n: Node, s: SpanNode): boolean =>
  s.kind === 'text'
    ? n.nodeType === 3 && (n as Text).data === s.value
    : s.kind === 'comment'
      ? n.nodeType === 8 && (n as Comment).data === s.value
      : s.kind === 'element'
        ? n.nodeType === 1 && nameOf(n as Element) === s.tag && (n as Element).namespaceURI === s.namespace
        : n.nodeType === 9;

/** 断言没有错配：每个已配对节点浅相等、逆映射一致、父子关系与区间树一致。返回 [已配对, 总数]。 */
function checkNoMispair(doc: Document, m: PreserveMount): [number, number] {
  let paired = 0;
  let total = 0;
  for (const n of walk(doc)) {
    total++;
    const s = m.spanOf(n);
    if (!s) continue;
    paired++;
    expect(shallowEq(n, s), `${n.nodeName} ↔ ${s.kind}`).toBe(true);
    expect(m.nodeOf(s)).toBe(n);
    if (s.parent) {
      const p = m.nodeOf(s.parent);
      // template 内容的父是 DocumentFragment（区间树里是 template 元素），跳过
      if (n.parentNode?.nodeType !== 11) expect(p).toBe(n.parentNode);
    }
  }
  return [paired, total];
}

function req<T>(v: T | null | undefined, what = 'value'): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

const q = (sel: string): HTMLElement => req(document.querySelector<HTMLElement>(sel), sel);

let active: PreserveMount | null = null;
beforeEach(() => {
  active?.unmount();
  active = null;
});
const mountSpec = (source: string, opts?: Parameters<typeof mountPreserve>[2]): PreserveMount => {
  loadSpec(document, source);
  active = mountPreserve(document, buildSpanIndex(source), opts);
  return active;
};

describe('配对', () => {
  it.each(fixtures)('%s：每个节点都与区间配对，文本值一致', (_name, source) => {
    const m = mountSpec(source);
    let texts = 0;
    for (const n of walk(document)) {
      if ((n as Element).hasAttribute?.(STYLE_ATTR) || n.parentNode === document.querySelector(`[${STYLE_ATTR}]`))
        continue;
      const s = m.spanOf(n);
      expect(s, `${n.nodeName} 未配对`).toBeDefined();
      if (n.nodeType === 3) {
        expect(s?.kind).toBe('text');
        expect(s?.kind === 'text' ? s.value : null).toBe((n as Text).data);
        texts++;
      }
    }
    expect(texts).toBeGreaterThan(0);
    expect(document.querySelectorAll(`[${GENERATED_ATTR}]`)).toHaveLength(0);
    checkNoMispair(document, m);
  });

  it.each(fixtures)('%s：happy-dom 原生解析器下也不错配', (_name, source) => {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    const m = mountPreserve(doc, buildSpanIndex(source));
    const [paired, total] = checkNoMispair(doc, m);
    expect(paired).toBeGreaterThan(0);
    expect(paired).toBeLessThanOrEqual(total);
    // 可编辑容器的子树必然全部配对
    for (const c of m.containers()) for (const n of walk(c)) expect(m.spanOf(n), n.nodeName).toBeDefined();
    m.unmount();
  });

  it('happy-dom 不丢 <pre> 开头换行（与规范不符）→ 该 <pre> 不可编辑，其余照常', () => {
    const source = fixture('01-handwritten-notes.html');
    const doc = new DOMParser().parseFromString(source, 'text/html');
    const m = mountPreserve(doc, buildSpanIndex(source));
    const pre = req(doc.querySelector('pre'));
    expect(pre.firstChild?.textContent?.startsWith('\n')).toBe(true);
    expect(m.spanOf(req(pre.firstChild))).toBeUndefined();
    expect(m.isEditable(pre)).toBe(false);
    expect(m.containers().length).toBeGreaterThan(3);
    m.unmount();
  });
});

describe('可编辑判定', () => {
  it('选最外层文本容器：容器不嵌套，行内元素不单独开启', () => {
    const m = mountSpec(fixture('02-ai-generated-page.html'));
    const cs = m.containers();
    expect(cs.length).toBeGreaterThan(5);
    for (const c of cs) {
      expect(c.getAttribute('contenteditable')).toBe('true');
      expect(c.parentNode ? m.containerOf(c.parentNode) : undefined).toBeUndefined();
      expect(m.spanOf(c)?.kind === 'element' && m.spanOf(c)).toMatchObject({ inner: expect.anything() });
    }
    const tags = new Set(cs.map((c) => c.localName));
    expect(tags.has('p') && tags.has('li') && tags.has('h1')).toBe(true);
    expect(tags.has('strong') || tags.has('code')).toBe(false);
  });

  it('script / style / svg / canvas / iframe / 表单控件 / template 内部永不可编辑', () => {
    const src = `<!doctype html><body>
<p>正文</p>
<script>var s = "<p>x</p>";</script><style>p{}</style>
<svg><text>图中文字</text><foreignObject><p>外来</p></foreignObject></svg>
<math><mi>x</mi></math>
<canvas>后备</canvas><iframe>后备</iframe>
<button>按钮</button><label>标签<input></label><textarea>文本域</textarea><select><option>选项</option></select>
<template><p>模板</p></template>
<div>纯文本 div</div><div><p>段</p>散落文本</div>
<p contenteditable="false">作者自带</p>
</body>`;
    const m = mountSpec(src);
    const editable = m.containers().map((c) => c.textContent);
    expect(editable).toEqual(['正文', '纯文本 div', '段']);
  });

  it('Word 粘贴的 o:p 不妨碍段落成为容器', () => {
    const m = mountSpec('<p class=MsoNormal><span>文字<o:p></o:p></span></p>');
    expect(m.containers().map((c) => c.localName)).toEqual(['p']);
  });
});

describe('E2E（happy-dom 模拟）：ECharts 页面', () => {
  /** 模拟 echarts.init(el).setOption(...)：往容器里塞一个 div>canvas，并改容器样式。 */
  const fakeEcharts = (el: HTMLElement): void => {
    el.setAttribute('_echarts_instance_', 'ec_1');
    const wrap = document.createElement('div');
    wrap.style.position = 'relative';
    wrap.appendChild(document.createElement('canvas'));
    const tip = document.createElement('div');
    tip.textContent = '周三 1290';
    wrap.appendChild(tip);
    el.appendChild(wrap);
  };

  it('正文可改、图表区标灰且不可改', async () => {
    const generated: Element[] = [];
    const m = mountSpec(fixture('03-echarts.html'), { onGenerated: (el) => generated.push(el) });
    const before = m.containers().map((c) => c.localName);
    expect(before).toEqual(['h1', 'p', 'h2', 'h2', 'p']);
    expect(document.querySelectorAll(`style[${STYLE_ATTR}]`)).toHaveLength(1);

    for (const id of ['pv-chart', 'source-chart', 'heat']) fakeEcharts(q(`#${id}`));
    q('#heat').style.height = '300px';
    await new Promise((r) => setTimeout(r, 0)); // 让 MutationObserver 自然派发

    // 正文仍可编辑
    expect(m.containers().map((c) => c.localName)).toEqual(before);
    expect(m.isEditable(req(q('h1').firstChild))).toBe(true);
    expect(q('p').getAttribute('contenteditable')).toBe('true');
    // 图表区：生成的节点标灰、带提示、不可编辑
    for (const id of ['pv-chart', 'source-chart', 'heat']) {
      const chart = q(`#${id}`);
      const wrap = req(chart.firstElementChild);
      expect(wrap.hasAttribute(GENERATED_ATTR)).toBe(true);
      expect(wrap.getAttribute('title')).toBe(GENERATED_TIP);
      expect(m.isEditable(wrap)).toBe(false);
      expect(m.isEditable(chart)).toBe(false);
      expect(chart.querySelector('[contenteditable]')).toBeNull();
      expect(m.spanOf(wrap)).toBeUndefined();
      expect(m.spanOf(chart)?.kind).toBe('element');
    }
    // 只标最外层生成节点
    expect(generated).toHaveLength(3);
  });

  it('脚本改了正文容器 → 收回可编辑并标灰', () => {
    const m = mountSpec(fixture('03-echarts.html'));
    const p = q('p');
    req(p.firstChild as Text).data = '脚本改写';
    m.flush();
    expect(p.hasAttribute('contenteditable')).toBe(false);
    expect(p.hasAttribute(GENERATED_ATTR)).toBe(true);
    expect(m.isEditable(p)).toBe(false);
    expect(m.containers()).not.toContain(p);
  });

  it('02：脚本往空 <p> 里写计数 → 新文本不可编辑、该 p 本就不是容器', () => {
    const m = mountSpec(fixture('02-ai-generated-page.html'));
    const tip = q('#generated-tip');
    expect(m.isEditable(tip)).toBe(false);
    const b = document.createElement('b');
    b.textContent = '已复习 3 次';
    tip.appendChild(b);
    m.flush();
    expect(b.hasAttribute(GENERATED_ATTR)).toBe(true);
  });
});

describe('用户编辑 vs 脚本改动', () => {
  it('beforeinput → input 窗口内的变动算用户编辑：保持可编辑、回调 onUserEdit、新节点不标灰', () => {
    const edited: HTMLElement[] = [];
    const m = mountSpec('<h1>标题</h1><p>第一段</p>', { onUserEdit: (c) => edited.push(c) });
    const p = q('p');
    const text = req(p.firstChild as Text);
    text.dispatchEvent(new Event('beforeinput', { bubbles: true }));
    text.data = '第一段改';
    p.appendChild(document.createElement('br'));
    text.dispatchEvent(new Event('input', { bubbles: true }));
    expect(edited).toEqual([p]);
    expect(m.isEditable(p)).toBe(true);
    expect(document.querySelector(`[${GENERATED_ATTR}]`)).toBeNull();
    // 窗口已关闭：之后的变动视为脚本
    text.data = '脚本';
    m.flush();
    expect(m.isEditable(p)).toBe(false);
  });

  it('输入法组合期间的变动算用户编辑', () => {
    const m = mountSpec('<p>拼音</p>');
    const p = q('p');
    p.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    req(p.firstChild as Text).data = '拼音 pin';
    m.flush();
    expect(m.isEditable(p)).toBe(true);
    p.dispatchEvent(new Event('compositionend', { bubbles: true }));
    expect(m.isEditable(p)).toBe(true);
  });

  it('userEdit() 内的变动（工具栏/execCommand）算用户编辑，之前挂起的脚本变动仍按脚本处理', () => {
    const edited: HTMLElement[] = [];
    const m = mountSpec('<p>甲</p><p>乙</p>', { onUserEdit: (c) => edited.push(c) });
    const [a, b] = [...document.querySelectorAll('p')];
    req(req(b).firstChild as Text).data = '脚本改乙';
    m.userEdit(() => {
      const strong = document.createElement('strong');
      strong.textContent = '加粗';
      req(a).appendChild(strong);
    });
    expect(edited).toEqual([a]);
    expect(m.isEditable(req(a))).toBe(true);
    expect(req(a).querySelector(`[${GENERATED_ATTR}]`)).toBeNull();
    expect(m.isEditable(req(b))).toBe(false);
  });
});

describe('分歧安全', () => {
  it('挂载前 DOM 被改：插入的节点不配对并标灰，被改的子树不可编辑，其余正常且无错配', () => {
    const source = fixture('02-ai-generated-page.html');
    loadSpec(document, source);
    const firstP = q('p');
    const intruder = document.createElement('p');
    intruder.textContent = req(firstP.textContent);
    firstP.before(intruder); // 同标签同文本的兄弟：最容易错配
    const li = q('li');
    req(li.lastChild as Text).data = '被脚本改过';
    const m = mountPreserve(document, buildSpanIndex(source));
    active = m;

    checkNoMispair(document, m);
    expect(m.isEditable(li)).toBe(false);
    expect(m.spanOf(req(li.lastChild))).toBeUndefined();
    // 两个同形 <p> 无法区分哪个是原文：都不配对，宁缺毋错
    expect(m.isEditable(intruder) && m.isEditable(firstP)).toBe(false);
    const sp = m.spanOf(intruder);
    const sf = m.spanOf(firstP);
    expect(sp === undefined || sf === undefined).toBe(true);
    // 远处的内容不受影响
    const h2 = q('h2');
    expect(m.isEditable(h2)).toBe(true);
    expect(m.containers().length).toBeGreaterThan(5);
  });

  it('删掉一个节点、换掉标签名也不会错配', () => {
    const source = '<body><p>一</p><p>二</p><p>三</p><div>四</div></body>';
    loadSpec(document, source);
    q('p').remove();
    const div = q('div');
    const sec = document.createElement('section');
    sec.textContent = '四';
    div.replaceWith(sec);
    const m = mountPreserve(document, buildSpanIndex(source));
    active = m;
    checkNoMispair(document, m);
    expect([...document.querySelectorAll('p')].map((p) => m.isEditable(p))).toEqual([true, true]);
    expect(m.spanOf(sec)).toBeUndefined();
    expect(sec.hasAttribute(GENERATED_ATTR)).toBe(true);
  });
});

describe('unmount', () => {
  it.each(fixtures)('%s：卸载后 DOM 与挂载前完全一致', (_name, source) => {
    loadSpec(document, source);
    const snapshot = document.documentElement.outerHTML;
    const m = mountPreserve(document, buildSpanIndex(source));
    expect(document.documentElement.outerHTML).not.toBe(snapshot);
    m.unmount();
    expect(document.documentElement.outerHTML).toBe(snapshot);
  });

  it('脚本改动并标灰之后卸载：只留下脚本自己的改动，停止观察', () => {
    const source = fixture('03-echarts.html');
    loadSpec(document, source);
    const m = mountPreserve(document, buildSpanIndex(source));
    const p = q('p');
    req(p.firstChild as Text).data = '脚本改写';
    const canvas = document.createElement('canvas');
    q('#heat').appendChild(canvas);
    m.flush();
    m.unmount();
    expect(document.querySelector(`[${GENERATED_ATTR}], [contenteditable], [${STYLE_ATTR}]`)).toBeNull();
    expect(p.hasAttribute('title') || canvas.hasAttribute('title')).toBe(false);
    q('#heat').appendChild(document.createElement('canvas'));
    m.flush();
    expect(document.querySelector(`[${GENERATED_ATTR}]`)).toBeNull();
  });
});

describe('transfer', () => {
  it('重建 <script> 后把区间转给新节点，不被标灰', () => {
    const source = '<body><p>正文</p><script>1</script></body>';
    const m = mountSpec(source);
    const old = q('script');
    const span = m.spanOf(old);
    const fresh = document.createElement('script');
    fresh.textContent = req(old.textContent);
    m.transfer(old, fresh);
    old.replaceWith(fresh);
    m.flush();
    expect(m.spanOf(fresh)).toBe(span);
    expect(m.nodeOf(req(span))).toBe(fresh);
    expect(fresh.hasAttribute(GENERATED_ATTR)).toBe(false);
  });
});
