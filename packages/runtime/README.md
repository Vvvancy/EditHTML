# @edithtml/runtime

嵌入文件的轻量加载器（< 8KB gzip）：阅读模式交互、切换编辑、保存；按文件类型分流原生/保真路径。

参见 docs/01-format-spec.md §8；任务 T2.7 T3.8

## 打开器（T2.7，`src/opener/`）

在浏览器中打开任意 `.html` 并进入保真模式。为守住体积预算，本包**不依赖** `@edithtml/importer`：
保真会话（`openPreserve`）由调用方注入，`apps/web` 负责把两者接起来。

| 模块 | 职责 |
| --- | --- |
| `encoding.ts` | `decodeHtml` / `encodeHtml`：严格 UTF-8，BOM 单独记录、保存时补回，未改动时逐字节往返 |
| `files.ts` | `pickWithHandle`（`showOpenFilePicker`）、`readDropped`（拖入，Chromium 下带句柄）、`readFile`、`writeBack`（`createWritable` 写回，否则下载） |
| `scripts.ts` | `parseInert` + `adoptInto`（脚本不执行地搭建 DOM）、`activateScripts`（挂载后按文档顺序激活并 `transfer`）、`scriptFingerprint` |
| `trust.ts` | `TrustStore`：用户选择「始终运行」的脚本指纹 |
| `frame.ts` | `loadInertFrame`（blob + sandbox 的同源 iframe）、`mountThenRun`、`loadPreserveFrame` |
| `controller.ts` | `PreserveController`：打开 → 编辑 → 脏标记 → 保存 → 在新文本上重开会话 |

加载顺序严格遵循 `importer/src/preserve/mount.ts` 的模块说明：先得到脚本未运行的 DOM 并挂载，再激活脚本。
