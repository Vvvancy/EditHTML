import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: { entry: 'src/index.ts', name: 'EhRuntime', formats: ['es'], fileName: () => 'eh-runtime.js' },
    target: 'es2022',
    minify: true,
  },
});
