import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    // Single bundle — no code splitting. VSCode webviews load scripts
    // via <script src="..."> (not type="module"), so dynamic import()
    // chunks with `import` statements would fail with SyntaxError.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
        // Force everything into a single chunk
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
  },
});
