/**
 * 性能基准（04 roadmap T1.2 验收：10,000 块 < 100ms，Node）。
 * CI 机器差异较大，断言使用宽松阈值 300ms，并打印实测时间。
 */
import { describe, expect, it } from 'vitest';
import { validateDoc } from '../model.js';
import { parse } from './parser.js';

function bigDoc(blocks: number): string {
  const lines: string[] = [];
  for (let i = 0; i < blocks; i++) {
    const id = `b${i.toString(36)}`;
    switch (i % 10) {
      case 0:
        lines.push(`<h2 data-eh="${id}">第 ${i} 节 Section</h2>`);
        break;
      case 1:
        lines.push(`<ul>\n  <li data-eh="${id}">列表项 <code>x</code></li>\n</ul>`);
        break;
      case 2:
        lines.push(`<pre data-eh="${id}" data-lang="ts"><code>const a = ${i} &lt; 2;\nconsole.log(a);</code></pre>`);
        break;
      case 3:
        lines.push(
          `<eh-chart data-eh="${id}">\n  <script type="application/json">{"type":"bar","data":{"x":["A","B"],"y":[3,${i}]}}</script>\n  <!--eh:fallback--><div class="eh-fallback">chart</div><!--eh:fallback-->\n</eh-chart>`,
        );
        break;
      case 4:
        lines.push(
          `<table data-eh="${id}">\n  <thead><tr><th>A</th><th data-eh-align="center">B</th></tr></thead>\n  <tbody>\n    <tr><td>1</td><td data-eh-align="center">2</td></tr>\n  </tbody>\n</table>`,
        );
        break;
      default:
        lines.push(
          `<p data-eh="${id}">一段正文 ${i}，支持 <strong>粗体</strong>、<em>斜体</em>、<a href="https://example.com/?a=1&amp;b=2">链接</a> &amp; 实体。</p>`,
        );
    }
  }
  return [
    '<!doctype html>',
    '<html lang="zh-CN" data-eh-version="0.1">',
    '  <head>',
    '    <meta charset="utf-8">',
    '    <title>bench</title>',
    '  </head>',
    '  <body>',
    '    <main id="eh-doc">',
    ...lines.map((l) => l.replace(/^/gm, '      ')),
    '    </main>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

describe('parse performance', () => {
  it('parses a 10,000-block document quickly', () => {
    const html = bigDoc(10_000);
    // 预热（JIT）
    for (let i = 0; i < 3; i++) parse(html);
    const runs: number[] = [];
    let result = parse(html);
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      result = parse(html);
      runs.push(performance.now() - t0);
    }
    const best = Math.min(...runs);
    const median = [...runs].sort((a, b) => a - b)[2] as number;
    console.log(
      `[bench] parse 10k blocks (${(html.length / 1024).toFixed(0)} KiB): best ${best.toFixed(1)}ms, median ${median.toFixed(1)}ms`,
    );
    expect(result.doc.root).toHaveLength(10_000);
    expect(result.warnings).toEqual([]);
    expect(validateDoc(result.doc)).toEqual([]);
    expect(median).toBeLessThan(300);
  });
});
