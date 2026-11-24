// The single-file preview has to stay under 2 MB: the Claude phone app previews an HTML file up to
// that size and shows a larger one as code (see AGENTS.md). A third of the file used to be its five
// fonts. `build-preview.mjs` packs each as the WOFF2 copy kept in scripts/preview-fonts, which is
// the same font compressed, nothing left out. This holds those copies to the fonts the app loads.

// This project has no Node types, so the two modules are asked for by name with the calls used here.
type Files = {
  existsSync(file: string): boolean;
  readdirSync(dir: string): string[];
  readFileSync(file: string): Uint8Array;
  readFileSync(file: string, encoding: 'utf8'): string;
};
type Hashes = { createHash(kind: 'md5'): { update(data: Uint8Array): { digest(as: 'hex'): string } } };
const fs = jest.requireActual<Files>('fs');
const crypto = jest.requireActual<Hashes>('crypto');

const here = expect.getState().testPath ?? '';
const root = here.slice(0, here.search(/[\\/]scripts[\\/]/));

/** The fonts the app loads, read from its own imports: the package and the weight of each. */
const loaded = [...fs.readFileSync(`${root}/App.tsx`, 'utf8').matchAll(/@expo-google-fonts\/([\w-]+)\/(\w+)'/g)].map((m) => [m[1], m[2]]);

describe('the fonts packed into the preview', () => {
  it('are the five the app loads', () => {
    expect(loaded).toHaveLength(5);
  });

  it.each(loaded)('have a compressed copy of %s %s, made from the very file the app loads', (pkg, weight) => {
    const dir = `${root}/node_modules/@expo-google-fonts/${pkg}/${weight}`;
    const name = fs.readdirSync(dir).find((file) => file.endsWith('.ttf')) ?? '';
    const font = fs.readFileSync(`${dir}/${name}`);
    // The copy carries the hash of the file it was made from, as the built app names that file.
    const copy = `${root}/scripts/preview-fonts/${name.replace(/\.ttf$/, '')}.${crypto.createHash('md5').update(font).digest('hex')}.woff2`;
    expect(fs.existsSync(copy)).toBe(true);
    const packed = fs.readFileSync(copy);
    expect(String.fromCharCode(...packed.slice(0, 4))).toBe('wOF2');
    expect(packed.length).toBeLessThan(font.length / 2);
  });

  it('come with the licence the fonts are shared under', () => {
    expect(fs.readFileSync(`${root}/scripts/preview-fonts/OFL.txt`, 'utf8')).toContain('SIL Open Font License');
  });
});
