import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      output: {
        // IIFE = todo el bundle envuelto en (function(){ ... })()
        // Compatible con <script> clásico sin type="module"
        // Funciona perfectamente con file:// en Android WebView
        format: 'iife',
        name: 'SismologApp',
        // Sin code-splitting: todo en un único archivo
        inlineDynamicImports: true,
      }
    }
  }
});
