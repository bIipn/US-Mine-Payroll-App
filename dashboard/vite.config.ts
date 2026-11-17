import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

import { isSecretKey } from './src/lib/secretKey.ts';

/**
 * The dashboard reuses the app's own rules and exports from ../src (hours,
 * pay periods, the exam and checklist rules, the Excel and PDF writers), so the
 * office sees the same figures as the phones. Three things make that work from a
 * clean install of this folder alone, which is how Vercel builds it:
 *
 * - `@app` points at ../src.
 * - A bare import made by a file in ../src (`fflate`, for the Excel writer) is
 *   resolved from this folder's node_modules, not the app's, which is not
 *   installed when only the dashboard is built.
 * - Every file, ../src included, is compiled with this folder's tsconfig. The
 *   app's own tsconfig extends Expo's, which is not installed here either.
 *
 * The app's screens and services that touch the phone are never imported. If a
 * shared file ever pulls in React Native or Expo, the build stops and says which.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const appSrc = path.resolve(here, '../src');

// The shared date code works in the local time zone. Tests run in a fixed one so they mean the same everywhere.
process.env.TZ ??= 'America/Los_Angeles';

const PHONE_ONLY = /^(react-native|react-native-[\w-]+|@react-native[\w-]*\/|expo|expo-[\w-]+|@expo\/|@react-navigation\/|lucide-react-native|zustand)/;

function sharedCode(): Plugin {
  return {
    name: 'minemuster-shared-code',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !importer.startsWith(appSrc + path.sep)) return null;
      if (source.startsWith('.') || source.startsWith('/') || source.startsWith('\0') || /^[a-z]:/i.test(source)) return null;
      if (PHONE_ONLY.test(source)) {
        this.error(`${path.relative(here, importer)} imports ${source}, which only runs on a phone. The dashboard may use only the app's pure code.`);
      }
      return this.resolve(source, path.join(here, 'src', 'main.tsx'), { ...options, skipSelf: true });
    },
  };
}

/** Stop a build that would put a secret key into every browser that opens the page. */
function noSecretKey(mode: string): void {
  const key = loadEnv(mode, here, 'VITE_').VITE_SUPABASE_PUBLISHABLE_KEY ?? '';
  if (key && isSecretKey(key)) {
    throw new Error(
      'VITE_SUPABASE_PUBLISHABLE_KEY is a secret key, which gets past every rule the server keeps and must never be in a web page. ' +
        'Set it to the project\'s publishable key (sb_publishable_...), in Vercel or in .env.local, and build again.',
    );
  }
}

const config = {
  // Every file is compiled with this folder's tsconfig, ../src included. Left to look for the nearest
  // one, Vite would read the app's, which extends Expo's and fails where only this folder is installed.
  tsconfig: path.join(here, 'tsconfig.json'),
  plugins: [sharedCode(), react()],
  resolve: {
    alias: { '@app': appSrc },
  },
  server: {
    fs: { allow: [here, appSrc] },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    env: { TZ: 'America/Los_Angeles' },
  },
};

export default defineConfig(({ mode }) => {
  noSecretKey(mode);
  return config;
});
