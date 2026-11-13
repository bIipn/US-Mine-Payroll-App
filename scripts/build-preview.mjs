// Packs the web build into one self-contained HTML file: the app, its fonts and
// its images, with nothing to host. Open it in any browser, or send it to
// someone to tap through. Run with `npm run build:preview`.
//
// It works because the app keeps its navigation in memory and stores data on
// the device, so it needs no server and no URL routing.
import fs from 'node:fs';
import path from 'node:path';

const dist = 'dist';
const out = path.join('preview', 'us-mine-crew-preview.html');

let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const tag = html.match(/<script src="([^"]+)" defer><\/script>/);
if (!tag) throw new Error('Could not find the app bundle in dist/index.html. Run `npm run build:web` first.');

let js = fs.readFileSync(path.join(dist, tag[1]), 'utf8');

// Fonts and images are referenced by URL in the bundle. Inline each one.
const MIME = { ttf: 'font/ttf', png: 'image/png' };
let inlined = 0;
js = js.replace(/"(\/assets\/[^"]+\.(ttf|png))"/g, (whole, url, ext) => {
  const file = path.join(dist, url);
  if (!fs.existsSync(file)) return whole;
  inlined += 1;
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
console.log(`${out}: ${(html.length / 1024 / 1024).toFixed(1)} MB, ${inlined} assets inlined`);
