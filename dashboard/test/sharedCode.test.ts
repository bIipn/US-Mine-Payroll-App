import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The dashboard reuses the app's pure code from ../src. Walk every import the
 * dashboard makes into it, and every import those files make in turn: none may
 * reach React Native, Expo or anything else that only runs on a phone, and
 * every bare package must be one the dashboard installs itself.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = path.resolve(here, '..');
const appSrc = path.resolve(dashboard, '../src');
const own = JSON.parse(readFileSync(path.join(dashboard, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|typeof import\(['"]([^'"]+)['"]\)/g;

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}

function resolveFile(base: string): string | undefined {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next
    }
  }
  return undefined;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('the app code the dashboard uses', () => {
  it('pulls in nothing that only runs on a phone, and no package the dashboard does not install', () => {
    const shared = new Set<string>();
    const bare = new Map<string, string>();
    const queue: string[] = [];
    for (const file of walk(path.join(dashboard, 'src'))) {
      for (const spec of importsOf(file)) {
        if (spec.startsWith('@app/')) {
          const target = resolveFile(path.join(appSrc, spec.slice(5)));
          expect(target, `${spec} from ${file}`).toBeDefined();
          queue.push(target!);
        }
      }
    }
    while (queue.length) {
      const file = queue.pop()!;
      if (shared.has(file)) continue;
      shared.add(file);
      for (const spec of importsOf(file)) {
        if (spec.startsWith('.')) {
          const target = resolveFile(path.resolve(path.dirname(file), spec));
          expect(target, `${spec} from ${file}`).toBeDefined();
          queue.push(target!);
        } else {
          bare.set(spec, path.relative(appSrc, file));
        }
      }
    }
    const files = [...shared].map((f) => path.relative(appSrc, f)).sort();
    // The one file from components is the company logo's outlines, which are data.
    expect(files.filter((f) => f.startsWith('components') || f.startsWith('screens') || f.startsWith('navigation'))).toEqual([path.join('components', 'logoArt.ts')]);
    expect(files).not.toContain(path.join('store', 'useStore.ts'));
    for (const [spec, from] of bare) {
      expect(spec, `${from} imports ${spec}`).not.toMatch(/react-native|expo|zustand|lucide/);
      expect(Object.keys(own.dependencies), `${from} imports ${spec}, which the dashboard does not install`).toContain(spec.split('/')[0]);
    }
    expect(files).toContain(path.join('services', 'xlsx.ts'));
  });
});
