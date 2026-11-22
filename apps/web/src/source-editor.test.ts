// @vitest-environment happy-dom
/**
 * 区域源码编辑（T2.5）× 打开器：页面脚本真实运行（happy-dom 开启 JS），替换图表区域的源码后脚本重绘，
 * 保存、就地重挂之后脚本生成的 DOM 仍不进源码。CodeMirror 界面本身只能手动验收（见 apps/web/README.md）。
 */
import { openPreserve, sourceRegions, type PreserveSession, type SourceRegion } from '@edithtml/importer';
import { PreserveController, TrustStore, adoptInto, decodeHtml, parseInert, type OpenedFile } from '@edithtml/runtime';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { bindSourcePopover } from './source-editor.js';

const windows: Window[] = [];
afterEach(async () => {
  for (const w of windows.splice(0)) await w.happyDOM.close();
});

type Log = { log: string[] };

function setup() {
  const written: string[] = [];
  const wins: (Window & Log)[] = [];
  const controller = new PreserveController<PreserveSession>({
    open: openPreserve,
    trust: new TrustStore(null),
    dirtyDelay: 0,
    async createDocument(source, runScripts) {
      const win = new Window({
        settings: { enableJavaScriptEvaluation: runScripts, suppressInsecureJavaScriptEnvironmentWarning: true },
      }) as Window & Log;
      win.log = [];
      windows.push(win);
      wins.push(win);
      return adoptInto(win.document as unknown as Document, parseInert(source, win as unknown as globalThis.Window));
    },
    async write(_file, text) {
      written.push(text);
      return 'written';
    },
  });
  return { controller, written, win: () => wins.at(-1) };
}

const fileOf = (text: string): OpenedFile => ({
  name: 'chart.html',
  handle: null,
  ...decodeHtml(new TextEncoder().encode(text)),
});

function req<T>(v: T | null | undefined, what = 'value'): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

const SRC = `<!DOCTYPE html>
<html><head></head>
<body>
<p>正文</p>
<div id="chart"></div>
<script>document.getElementById('chart').appendChild(document.createElement('canvas')); log.push('draw 1')</script>
</body></html>`;

function chartRegion(s: PreserveSession, doc: Document): SourceRegion {
  s.mount.flush();
  return req(sourceRegions(s, doc).find((r) => r.first.id === 'chart'));
}

describe('区域源码编辑 × 打开器（脚本运行中）', () => {
  it('替换图表区域的源码：新脚本执行、重绘；保存正确；重挂后生成的 DOM 仍不进源码', async () => {
    const { controller, written, win } = setup();
    await controller.open(fileOf(SRC));
    await controller.runScripts(false);
    const doc = req(controller.doc);
    const s = req(controller.session);
    expect(req(win()).log).toEqual(['draw 1']);

    const r = chartRegion(s, doc);
    expect(r.generated).toBe(true);
    const orig = s.getSource(r);
    expect(orig).toBe(
      `<div id="chart"></div>\n<script>document.getElementById('chart').appendChild(document.createElement('canvas')); log.push('draw 1')</script>`,
    );
    const html = orig.replace('draw 1', 'draw 2').replace('<div id="chart">', '<div id="chart" class="big">');
    s.replaceSource(r, html, { runScripts: true });
    expect(req(win()).log).toEqual(['draw 1', 'draw 2']);
    s.mount.flush();
    const chart = req(doc.getElementById('chart'));
    expect(chart.className).toBe('big');
    expect(chart.querySelector('canvas')).not.toBeNull();

    const expected = SRC.replace('draw 1', 'draw 2').replace('<div id="chart">', '<div id="chart" class="big">');
    controller.refreshDirty();
    expect(controller.dirty).toBe(true);
    expect(controller.text()).toBe(expected);
    expect(await controller.save()).toBe('written');
    expect(written).toEqual([expected]);

    // 就地重挂：页面未重建，图表的 canvas 仍在，但不属于源码
    expect(controller.doc).toBe(doc);
    const s2 = req(controller.session);
    expect(s2).not.toBe(s);
    const r2 = chartRegion(s2, doc);
    expect(s2.getSource(r2)).toBe(html);
    s2.insertAfter(req(doc.querySelector('p')), 'p', '新段');
    expect(s2.save()).toBe(expected.replace('<p>正文</p>', '<p>正文</p>\n<p>新段</p>'));
  });

  it('bindSourcePopover：会话更换时重建弹层（界面在宿主文档中）', async () => {
    const { controller } = setup();
    await controller.open(fileOf(SRC));
    const stage = document.createElement('main');
    document.body.appendChild(stage);
    let changes = 0;
    const binding = bindSourcePopover(
      controller,
      stage,
      () => changes++,
      () => Promise.reject(new Error('unused')),
    );
    binding.sync();
    const first = req(binding.popover);
    binding.sync();
    expect(binding.popover).toBe(first);
    expect(document.querySelector('.eh-src-btn')).not.toBeNull();
    expect(req(controller.doc).querySelector('.eh-src-btn')).toBeNull();

    await controller.runScripts(false); // 重建页面 → 新会话
    binding.sync();
    expect(binding.popover).not.toBe(first);
    expect(document.querySelectorAll('.eh-src-btn')).toHaveLength(1);
    controller.close();
    binding.sync();
    expect(binding.popover).toBeNull();
    expect(document.querySelector('.eh-src-btn')).toBeNull();
    expect(changes).toBe(0);
  });
});
