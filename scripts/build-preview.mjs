// Packs the web build into one self-contained HTML file: the app, its fonts and
// its images, with nothing to host. Open it in any browser, or send it to
// someone to tap through. Run with `npm run build:preview`.
//
// It works because the app keeps its navigation in memory and stores data on
// the device, so it needs no server and no URL routing.
//
// To pack a build that is somewhere else, name the folder and the file to write:
//     node scripts/build-preview.mjs <build folder> <file.html>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [dist = 'dist', out = path.join('preview', 'us-mine-crew-preview.html')] = process.argv.slice(2);

let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const tag = html.match(/<script src="([^"]+)" defer><\/script>/);
if (!tag) throw new Error(`Could not find the app bundle in ${path.join(dist, 'index.html')}. Run \`npm run build:web\` first.`);

let js = fs.readFileSync(path.join(dist, tag[1]), 'utf8');

// Fonts and images are referenced by URL in the bundle. Inline each one.
//
// A font goes in as its WOFF2 copy from scripts/preview-fonts: the same font compressed, about a
// third of the size. That is what keeps the file under 2 MB, and the Claude phone app previews an
// HTML file only up to that size; a larger one it shows as code. A copy is named after the font
// file as the build names it, hash and all, so it is only ever used for the font it was made from.
// `scripts/compress-preview-fonts.py` makes the copies.
const MIME = { ttf: 'font/ttf', png: 'image/png' };
const COPIES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'preview-fonts');
let inlined = 0;
const uncompressed = [];
js = js.replace(/"(\/assets\/[^"]+\.(ttf|png))"/g, (whole, url, ext) => {
  const file = path.join(dist, url);
  if (!fs.existsSync(file)) return whole;
  inlined += 1;
  if (ext === 'ttf') {
    const copy = path.join(COPIES, `${path.basename(url, '.ttf')}.woff2`);
    // The app's font rule names no format, so the browser reads the kind of font from the file itself.
    if (fs.existsSync(copy)) return JSON.stringify(`data:font/woff2;base64,${fs.readFileSync(copy).toString('base64')}`);
    uncompressed.push(path.basename(url));
  }
  return JSON.stringify(`data:${MIME[ext]};base64,${fs.readFileSync(file).toString('base64')}`);
});

// A literal "</script" inside the bundle would end the inline script early.
js = js.replace(/<\/script/gi, '<\\/script');

html = html
  .replace(/<link rel="icon"[^>]*>/, '')
  .replace(/<title>[^<]*<\/title>/, '<title>US Mine Crew preview</title>')
  .replace(tag[0], () => `<script>${js}</script>`);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
const bytes = Buffer.byteLength(html);
console.log(`${out}: ${(bytes / 1e6).toFixed(2)} MB, ${inlined} assets inlined`);
for (const name of uncompressed) {
  console.warn(`No compressed copy of ${name} in scripts/preview-fonts, so it went in whole. Run scripts/compress-preview-fonts.py.`);
}
// 2 MB as the phone counts it is 2 x 1024 x 1024 bytes. Say so before the file gets there.
if (bytes > 2_000_000) {
  console.warn(`The preview is ${bytes} bytes. Past 2,097,152 the Claude phone app shows it as code, with no preview.`);
}
