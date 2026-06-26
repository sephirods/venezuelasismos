const fs = require('fs');
const path = require('path');

const distIndexHtmlPath = path.join(__dirname, 'dist', 'index.html');

try {
  let html = fs.readFileSync(distIndexHtmlPath, 'utf8');
  
  // 1. Procesar etiquetas <script> de forma robusta
  html = html.replace(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/gi, (match, src) => {
    // Si es un script residual del main.js original, eliminarlo
    if (src.includes('src/main.js')) {
      return '';
    }
    // Si es el bundle de assets compilado, quitar type="module" y crossorigin, y asegurar defer
    if (src.includes('assets/')) {
      let clean = match
        .replace(/\btype="module"\b/gi, '')
        .replace(/\bcrossorigin\b/gi, '');
      if (!clean.toLowerCase().includes('defer')) {
        clean = clean.replace(/<script/i, '<script defer');
      }
      return clean;
    }
    return match;
  });
  
  // 2. Procesar etiquetas <link> de forma robusta (quitar crossorigin en hojas de estilo)
  html = html.replace(/<link\b[^>]*href="([^"]+)"[^>]*>/gi, (match, href) => {
    if (match.toLowerCase().includes('rel="stylesheet"')) {
      return match.replace(/\bcrossorigin\b/gi, '');
    }
    return match;
  });
  
  fs.writeFileSync(distIndexHtmlPath, html, 'utf8');
  console.log('Post-build: dist/index.html procesado con éxito para soporte WebView.');
} catch (e) {
  console.error('Error en script post-build:', e);
}
