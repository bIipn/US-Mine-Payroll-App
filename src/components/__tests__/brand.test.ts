// The MineMuster logo and icons are made by scripts/make-brand-assets.py from the renders in
// assets/brand/source. These hold them to what the stores and the screens need.

// This project has no Node types, so the file system is asked for by name with the calls used here.
const fs = jest.requireActual<{ readFileSync(file: string): Uint8Array; existsSync(file: string): boolean }>('fs');
const here = expect.getState().testPath ?? '';
const assets = `${here.slice(0, here.search(/[\\/]src[\\/]/))}/assets`;

const text = (bytes: Uint8Array, from: number, to: number) => [...bytes.slice(from, to)].map((c) => String.fromCharCode(c)).join('');

/** Width, height and whether a PNG has an alpha channel, from its header. */
function png(name: string) {
  const b = fs.readFileSync(`${assets}/${name}`);
  const word = (at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
  expect(text(b, 1, 4)).toBe('PNG');
  return { width: word(16), height: word(20), alpha: b[25] === 6 || b[25] === 4 };
}

/** Width, height and alpha of an extended WebP (VP8X), from its header. */
function webp(name: string) {
  const b = fs.readFileSync(`${assets}/${name}`);
  expect([text(b, 0, 4), text(b, 8, 12), text(b, 12, 16)]).toEqual(['RIFF', 'WEBP', 'VP8X']);
  const three = (at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
  return { width: three(24) + 1, height: three(27) + 1, alpha: (b[20] & 0x10) !== 0 };
}

describe('MineMuster brand assets', () => {
  it('keeps the two renders they are made from', () => {
    expect(fs.existsSync(`${assets}/brand/source/minemuster-lockup.png`)).toBe(true);
    expect(fs.existsSync(`${assets}/brand/source/minemuster-mark.png`)).toBe(true);
  });

  it('has an app icon the stores take: 1024 square, with no transparency', () => {
    expect(png('icon.png')).toEqual({ width: 1024, height: 1024, alpha: false });
  });

  it('has an Android adaptive icon: a transparent mark over a solid background', () => {
    expect(png('android-icon-foreground.png')).toEqual({ width: 1024, height: 1024, alpha: true });
    expect(png('android-icon-background.png')).toEqual({ width: 1024, height: 1024, alpha: false });
    expect(png('android-icon-monochrome.png')).toEqual({ width: 1024, height: 1024, alpha: true });
  });

  it('has a launch image with a transparent background, and a browser-tab icon', () => {
    expect(png('splash-icon.png').alpha).toBe(true);
    expect(png('favicon.png')).toMatchObject({ width: 48, height: 48 });
  });

  it('has the sign-in logo sharp at 280 points on a 3x screen, see-through, in the shape the screen sizes it to', () => {
    expect(webp('brand/minemuster-logo.webp')).toEqual({ width: 840, height: 390, alpha: true });
  });

  it('keeps the sign-in logo small enough for the one-file preview', () => {
    expect(fs.readFileSync(`${assets}/brand/minemuster-logo.webp`).length).toBeLessThan(120_000);
  });
});
