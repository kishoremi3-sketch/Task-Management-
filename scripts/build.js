// Bundles the app into one self-contained HTML file (inline CSS and JS).
// The result opens straight from disk, with no server needed.
//
//   node scripts/build.js                 -> dist/taskflow.html
//   node scripts/build.js --fragment out  -> page body only, for hosts that
//                                            supply their own <html>/<head>
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(root, p), 'utf8');

// Modules in dependency order; each is turned into plain script code.
const modules = ['js/store.js', 'js/auth-config.js', 'js/auth.js', 'js/backend.js', 'js/xlsx.js', 'js/report.js', 'js/app.js'];
const [html, css, ...sources] = await Promise.all([
  read('index.html'), read('css/styles.css'), ...modules.map(read),
]);

const code = sources.map((src, i) => {
  const out = src
    .replace(/^import \{[\s\S]*?\} from '\.\/[\w-]+\.js';\n/gm, '')
    .replace(/^export /gm, '');
  if (/^(import|export) /m.test(out)) throw new Error(`Unsupported import/export left in ${modules[i]}`);
  return `// ---- ${modules[i]} ----\n${out}`;
}).join('\n');
const js = `(() => {\n'use strict';\n${code}\n})();`;
if (/<\/script/i.test(js)) throw new Error('Script contains a closing </script> tag');

const page = html
  .replace('<link rel="stylesheet" href="css/styles.css">', () => `<style>\n${css}</style>`)
  .replace('<script type="module" src="js/app.js"></script>', () => `<script>\n${js}\n</script>`);
if (page.includes('href="css/styles.css"') || page.includes('src="js/app.js"')) {
  throw new Error('Failed to inline assets; did index.html change?');
}

const fragmentIndex = process.argv.indexOf('--fragment');
if (fragmentIndex !== -1) {
  const out = process.argv[fragmentIndex + 1];
  if (!out) throw new Error('--fragment needs an output path');
  const head = page.match(/<head>([\s\S]*?)<\/head>/)[1]
    .replace(/<meta[^>]*>\s*/g, '')
    .replace(/<link rel="icon" href="[^"]*">\s*/g, '');
  const body = page.match(/<body>([\s\S]*?)<\/body>/)[1];
  await writeFile(out, `${head.trim()}\n${body.trim()}\n`);
  console.log(`Wrote ${out}`);
} else {
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist/taskflow.html'), page);
  console.log('Wrote dist/taskflow.html');
}
