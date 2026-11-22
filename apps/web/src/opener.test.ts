// @vitest-environment happy-dom
/**
 * 打开器 + 保真会话的集成测试（真实的 importer `openPreserve`，用 happy-dom 文档代替 iframe）。
 * 浏览器中的 iframe / File System Access 部分只能手动验收，见 apps/web/README.md。
 */
import { GENERATED_ATTR, openPreserve, type PreserveSession } from '@edithtml/importer';
import {
  PreserveController,
  TrustStore,
  adoptInto,
  decodeHtml,
  encodeHtml,
  parseInert,
  type OpenedFile,
} from '@edithtml/runtime';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';

const windows: Window[] = [];
afterEach(async () => {
  for (const w of windows.splice(0)) await w.happyDOM.close();
});

type Log = { log: string[] };

/** 模拟打开器的 iframe：受信任时用允许执行 JS 的窗口，否则用不执行 JS 的窗口。 */
function setup(trust = new TrustStore(null), onChange?: () => void) {
  const written: Uint8Array[] = [];
  const docs: { doc: Document; win: Window & Log }[] = [];
  const controller = new PreserveController<PreserveSession>({
    open: openPreserve,
    trust,
    onChange,
    dirtyDelay: 0,
    async createDocument(source, runScripts) {
      const win = new Window({
        settings: { enableJavaScriptEvaluation: runScripts, suppressInsecureJavaScriptEnvironmentWarning: true },
      }) as Window & Log;
      win.log = [];
      windows.push(win);
      const doc = adoptInto(
        win.document as unknown as Document,
        parseInert(source, win as unknown as globalThis.Window),
      );
      docs.push({ doc, win });
      return doc;
    },
    async write(file, text) {
      written.push(encodeHtml({ text, bom: file.bom }));
      return 'written';
    },
  });
  const current = (): { doc: Document; win: Window & Log } => {
    const d = docs.at(-1);
    if (!d) throw new Error('尚未打开');
    return d;
  };
  return { controller, written, current };
}

const fileOf = (bytes: Uint8Array, name = 'note.html'): OpenedFile => ({ name, handle: null, ...decodeHtml(bytes) });
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const withBom = (s: string): Uint8Array => new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(s)]);

/** 模拟用户在容器里改字。 */
function typeInto(session: PreserveSession, el: Element, text: string): void {
  session.mount.userEdit(() => {
    const t = el.firstChild;
    if (t?.nodeType !== 3) throw new Error('期望文本节点');
    (t as Text).data = text;
  });
  session.touch(el);
}

function requireSession(c: PreserveController<PreserveSession>): PreserveSession {
  const s = c.session;
  if (!s) throw new Error('没有会话');
  return s;
}

const NOTE =
  '<!DOCTYPE html>\r\n<html>\r\n<head><title>笔记</title></head>\r\n<body>\r\n  <h1>标题</h1>\r\n  <p>第一段</p>\r\n</body>\r\n</html>\r\n';

describe('打开 → 编辑 → 保存', () => {
  it('未改动时保存什么也不写，内容与原文件逐字节相同（含 BOM）', async () => {
    const { controller, written } = setup();
    const bytes = withBom(NOTE);
    await controller.open(fileOf(bytes));
    expect(controller.dirty).toBe(false);
    expect(encodeHtml({ text: controller.text(), bom: true })).toEqual(bytes);
    expect(await controller.save()).toBe('unchanged');
    expect(written).toHaveLength(0);
  });

  it('改一个字：脏标记 → 保存只改动那一处、保留 BOM 与 CRLF → 会话重开在新文本上', async () => {
    const changes: boolean[] = [];
    const { controller, written, current } = setup();
    await controller.open(fileOf(withBom(NOTE)));
    const { doc } = current();
    const p = doc.querySelector('p');
    if (!p) throw new Error('缺少 <p>');
    typeInto(requireSession(controller), p, '第二段');
    controller.refreshDirty();
    changes.push(controller.dirty);

    expect(await controller.save()).toBe('written');
    const expected = withBom(NOTE.replace('第一段', '第二段'));
    expect(written[0]).toEqual(expected);
    expect(controller.dirty).toBe(false);

    // 就地重挂：仍是同一个文档，会话的原文是新文本，继续编辑与保存都正确
    expect(current().doc).toBe(doc);
    const s2 = requireSession(controller);
    expect(s2.source).toBe(NOTE.replace('第一段', '第二段'));
    expect(s2.mount.isEditable(p)).toBe(true);
    const h1 = doc.querySelector('h1');
    if (!h1) throw new Error('缺少 <h1>');
    typeInto(s2, h1, '新标题');
    await controller.save();
    expect(written[1]).toEqual(withBom(NOTE.replace('第一段', '第二段').replace('标题</h1>', '新标题</h1>')));
    expect(changes).toEqual([true]);
  });

  it('改回原样后脏标记消失', async () => {
    const { controller, current } = setup();
    await controller.open(fileOf(utf8(NOTE)));
    const p = current().doc.querySelector('p');
    if (!p) throw new Error('缺少 <p>');
    const s = requireSession(controller);
    typeInto(s, p, '改了');
    controller.refreshDirty();
    expect(controller.dirty).toBe(true);
    typeInto(s, p, '第一段');
    controller.refreshDirty();
    expect(controller.dirty).toBe(false);
  });

  it('用户输入经 onUserEdit 自动刷新脏标记', async () => {
    let changes = 0;
    const { controller, current } = setup(undefined, () => changes++);
    await controller.open(fileOf(utf8(NOTE)));
    const p = current().doc.querySelector('p');
    if (!p) throw new Error('缺少 <p>');
    const t = p.firstChild as Text;
    // 模拟浏览器的 beforeinput → 修改 → input 窗口
    p.dispatchEvent(new Event('beforeinput', { bubbles: true }));
    t.data = '输入';
    p.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(controller.dirty).toBe(true);
    expect(changes).toBeGreaterThan(1);
  });
});

const SCRIPTED = `<!DOCTYPE html>
<html><head><script>log.push('head')</script></head>
<body>
<p>正文</p>
<div id="chart"></div>
<script>document.getElementById('chart').appendChild(document.createElement('canvas')); log.push('body')</script>
</body></html>`;

describe('页面脚本', () => {
  it('不受信任：脚本不执行；运行后按顺序执行，脚本元素不被标灰，脚本生成的内容标灰', async () => {
    const trust = new TrustStore(null);
    const { controller, current } = setup(trust);
    await controller.open(fileOf(utf8(SCRIPTED)));
    expect(controller.scripts).toBe('blocked');
    expect(current().win.log).toEqual([]);

    await controller.runScripts(true);
    expect(controller.scripts).toBe('running');
    const { doc, win } = current();
    expect(win.log).toEqual(['head', 'body']);
    const s = requireSession(controller);
    s.mount.flush();
    for (const el of Array.from(doc.querySelectorAll('script'))) expect(el.hasAttribute(GENERATED_ATTR)).toBe(false);
    expect(doc.querySelector('canvas')?.hasAttribute(GENERATED_ATTR)).toBe(true);
    const p = doc.querySelector('p');
    if (!p) throw new Error('缺少 <p>');
    expect(s.mount.isEditable(p)).toBe(true);
    expect(s.save()).toBe(SCRIPTED); // 激活脚本不产生补丁

    // 记住了信任：再次打开同样的脚本直接运行
    await controller.open(fileOf(utf8(SCRIPTED.replace('正文', '别的正文'))));
    expect(controller.scripts).toBe('running');
    expect(current().win.log).toEqual(['head', 'body']);
  });

  it('运行脚本时保留未保存的修改', async () => {
    const { controller, current } = setup();
    await controller.open(fileOf(utf8(SCRIPTED)));
    const p = current().doc.querySelector('p');
    if (!p) throw new Error('缺少 <p>');
    typeInto(requireSession(controller), p, '先改再运行');
    await controller.runScripts(false);
    expect(current().doc.querySelector('p')?.textContent).toBe('先改再运行');
    expect(controller.dirty).toBe(true);
    expect(controller.text()).toBe(SCRIPTED.replace('正文', '先改再运行'));
  });

  it('没有脚本的文件：scripts 为 none', async () => {
    const { controller } = setup();
    await controller.open(fileOf(utf8(NOTE)));
    expect(controller.scripts).toBe('none');
  });
});
