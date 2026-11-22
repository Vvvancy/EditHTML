import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { conditions: ['source'] },
  build: {
    // CodeMirror（含 HTML/CSS/JS 语法）单独成一个按需加载的分包，约 530 kB（gzip 约 180 kB），只在第一次打开源码弹层时下载。
    chunkSizeWarningLimit: 600,
  },
});
