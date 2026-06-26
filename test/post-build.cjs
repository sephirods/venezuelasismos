const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');
const htmlPath = path.join(distDir, 'index.html');
const assetsDir = path.join(distDir, 'assets');

try {
  let html = fs.readFileSync(htmlPath, 'utf8');

  // 1. Encontrar el archivo JS del bundle (IIFE)
  const jsMatch = html.match(/src="\.\/assets\/(index-[^"]+\.js)"/);
  if (!jsMatch) throw new Error('No se encontró el script del bundle en el HTML');
  const jsFile = jsMatch[1];
  const jsPath = path.join(assetsDir, jsFile);
  const jsContent = fs.readFileSync(jsPath, 'utf8');

  // 2. Extraer el CSS que Vite embebió dentro del IIFE
  //    Formato: X.textContent=`...css...`,document.head.appendChild(X)
  //    donde X puede ser cualquier letra (T, F, etc. según el build)
  const cssInBundle = jsContent.match(/\w\.textContent=`([\s\S]+?)`,document\.head\.appendChild/);
  if (cssInBundle) {
    const css = cssInBundle[1];
    // Insertar como <style> directo en el <head> ANTES que cualquier script
    // Esto aplica el CSS inmediatamente al cargar el HTML, sin esperar al JS
    html = html.replace('</head>', `<style>${css}</style>\n</head>`);
    console.log(`CSS extraído e incrustado directamente: ${Math.round(css.length / 1024)}KB`);
  } else {
    console.warn('No se encontró CSS en el bundle — comprueba el formato del IIFE');
  }

  // 3. Limpiar el <script> del bundle: quitar crossorigin, type="module", pero conservar/añadir defer
  html = html.replace(
    /<script[^>]+src="(\.\/assets\/index-[^"]+\.js)"[^>]*><\/script>/,
    '<script defer src="$1"></script>'
  );

  // 4. Quitar crossorigin de <link> tags
  html = html.replace(/\s+crossorigin\b/g, '');

  // 5. Quitar scripts residuales del dev mode de Vite (src/main.js)
  html = html.replace(/<script[^>]+src="[^"]*src\/main\.js"[^>]*><\/script>/g, '');

  // Eliminar todos los APK del dist — Vite copia todo public/ al dist, incluyendo los APK
  // Esto evitará que queden como assets de la app Android y en la carpeta web
  fs.readdirSync(distDir).forEach(file => {
    if (file.endsWith('.apk')) {
      fs.unlinkSync(path.join(distDir, file));
      console.log(`APK eliminado del dist: ${file}`);
    }
  });

  fs.writeFileSync(htmlPath, html, 'utf8');

  // Mostrar resumen
  console.log('\nPost-build OK. Recursos en el HTML final:');
  html.split('\n').forEach(line => {
    const t = line.trim();
    if (t.match(/^<(script|link|style)/i)) {
      const preview = t.startsWith('<style>') ? '<style>[CSS incrustado]</style>' : t.substring(0, 90);
      console.log(' ', preview);
    }
  });

} catch (e) {
  console.error('Error en post-build:', e.message);
  process.exit(1);
}
