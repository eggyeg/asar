const fs = require('fs'), path = require('path');
const esbuild = require('esbuild');
const { minify } = require('html-minifier-terser');
const asar = require('@electron/asar');

const SRC = path.join(__dirname, 'src'), OUT = path.join(__dirname, 'dist', 'app'), ASAR = path.join(__dirname, 'dist', 'app.asar');
const RENDERER = new Set(['mainWindow.js', 'config/preload.js', 'splash/preload.js']);

(async () => {
  fs.rmSync(path.join(__dirname, 'dist'), { recursive: true, force: true });
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  let before = 0, after = 0;
  for (const f of walk(SRC)) {
    const rel = path.relative(SRC, f).replaceAll('\\', '/'), out = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    let code = fs.readFileSync(f, 'utf8'); before += Buffer.byteLength(code);
    if (f.endsWith('.js')) {
      code = (await esbuild.transform(code, { minify: true, target: RENDERER.has(rel) ? 'chrome120' : 'node20', legalComments: 'none', charset: 'utf8' })).code;
    } else if (f.endsWith('.html')) {
      code = await minify(code, { collapseWhitespace: true, removeComments: true, minifyCSS: true, minifyJS: { ecma: 2022 }, removeAttributeQuotes: true });
    }
    after += Buffer.byteLength(code);
    fs.writeFileSync(out, code);
  }
  fs.copyFileSync(path.join(__dirname, 'LICENSE'), path.join(OUT, 'LICENSE'));
  await asar.createPackage(OUT, ASAR);
  console.log(`source ${before} B -> minified ${after} B; app.asar ${fs.statSync(ASAR).size} B`);
})().catch(e => { console.error(e); process.exit(1); });
