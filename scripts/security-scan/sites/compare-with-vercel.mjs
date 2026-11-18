#!/usr/bin/env node
// Checks vercel-rules.mjs against Vercel's own code: the route table that getTransformedRoutes in
// @vercel/routing-utils makes of site/vercel.json and dashboard/vercel.json has to be the one
// this server follows, expression for expression and in the same order.
//
// The package is Vercel's and is not a dependency of this folder (it pins an old path-to-regexp).
// Install it somewhere private and say where:
//
//   npm install --prefix <private folder> --ignore-scripts @vercel/routing-utils
//   node compare-with-vercel.mjs --routing-utils <private folder>/node_modules/@vercel/routing-utils

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { REPO, readArgs } from './layout.mjs';
import { CLEAN_URL_REDIRECTS, readConfig } from './vercel-rules.mjs';

const args = readArgs(process.argv.slice(2));
if (typeof args['routing-utils'] !== 'string') {
  console.error('Say where Vercel\'s package is: --routing-utils <folder>/node_modules/@vercel/routing-utils');
  process.exit(1);
}
const packageDir = path.resolve(args['routing-utils']);
const require = createRequire(path.join(packageDir, 'package.json'));
const { getTransformedRoutes } = require(packageDir);
const { version } = require(path.join(packageDir, 'package.json'));

// Vercel writes a slash plain; a RegExp's source writes it escaped. They are the same expression.
const plain = (regex) => regex.source.replaceAll('\\/', '/');

let wrong = 0;
for (const name of ['site', 'dashboard']) {
  const config = JSON.parse(readFileSync(path.join(REPO, name, 'vercel.json'), 'utf8'));
  const { routes, error } = getTransformedRoutes(config);
  if (error) throw new Error(`Vercel's package refuses ${name}/vercel.json: ${error.message}`);
  const rules = readConfig(config);

  // What this server follows, laid out as Vercel lays out its routes.
  const mine = [
    ...(rules.cleanUrls ? CLEAN_URL_REDIRECTS.map((regex) => ({ src: plain(regex), headers: { Location: '/$1' }, status: 308 })) : []),
    ...rules.headerRules.map((rule) => ({ src: plain(rule.regex), headers: Object.fromEntries(rule.headers.map((h) => [h.key, h.value])), continue: true })),
    ...(rules.rewrites.length > 0 ? [{ handle: 'filesystem' }] : []),
    ...rules.rewrites.map((rule) => ({ src: plain(rule.regex), dest: rule.destination, check: true })),
  ];
  const same = JSON.stringify(mine) === JSON.stringify(routes);
  console.log(`${name}/vercel.json: ${routes.length} routes from @vercel/routing-utils ${version}, ${same ? 'the same as this server follows' : 'NOT the same as this server follows'}`);
  if (!same) {
    wrong++;
    console.log(JSON.stringify({ vercel: routes, here: mine }, null, 2));
  }
}
process.exit(wrong === 0 ? 0 : 1);
