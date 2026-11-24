// minemuster.com/demo is the app's one-file web build with the made-up sample crew. On an iPhone it
// is added to the Home Screen to be shown like the app itself: its own icon and name, opening full
// screen with no browser bars. These hold the page (made by scripts/build-preview.mjs) and its web
// manifest to that.

// This project has no Node types, so the file system is asked for by name with the calls used here.
type Files = { existsSync(file: string): boolean; readFileSync(file: string, encoding: 'utf8'): string };
const fs = jest.requireActual<Files>('fs');

const here = expect.getState().testPath ?? '';
const root = here.slice(0, here.search(/[\\/]scripts[\\/]/));
const demo = `${root}/site/demo`;

/** The page's <head>, up to its first script. */
const head = () => {
  const html = fs.readFileSync(`${demo}/index.html`, 'utf8');
  return html.slice(0, html.indexOf('<script'));
};

describe('the demo page opens like an app from an iPhone Home Screen', () => {
  it('says it runs full screen, under the name MineMuster, with MineMuster\'s icon', () => {
    const h = head();
    expect(h).toMatch(/<meta name="apple-mobile-web-app-capable" content="yes"\s*\/?>/);
    expect(h).toMatch(/<meta name="mobile-web-app-capable" content="yes"\s*\/?>/);
    expect(h).toMatch(/<meta name="apple-mobile-web-app-title" content="MineMuster"\s*\/?>/);
    expect(h).toMatch(/<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"\s*\/?>/);
    expect(h).toMatch(/<link rel="manifest" href="\/demo\/manifest\.webmanifest"\s*\/?>/);
    expect(h).toMatch(/<title>MineMuster<\/title>/);
  });

  it('has a manifest that opens /demo standalone, with icons that exist', () => {
    const manifest = JSON.parse(fs.readFileSync(`${demo}/manifest.webmanifest`, 'utf8')) as {
      name: string; short_name: string; start_url: string; scope: string; display: string; icons: { src: string; sizes: string }[];
    };
    expect(manifest).toMatchObject({ name: 'MineMuster', short_name: 'MineMuster', start_url: '/demo', scope: '/demo', display: 'standalone' });
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) expect(fs.existsSync(`${root}/site${icon.src}`)).toBe(true);
  });
});
