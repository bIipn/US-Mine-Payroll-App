// The stores require a link to the privacy policy inside the app, where it is easy to find (Apple
// 5.1.1(i)), and a way to reach the developer. These hold the app to opening MineMuster's own pages,
// that those pages exist on the website, and that the links are there before anyone has signed in.

import { Linking } from 'react-native';

import { WEB_PAGES } from '../../config';
import { openWebPage } from '../../services/links';

// This project has no Node types, so the file system is asked for by name with the calls used here.
const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string; existsSync(file: string): boolean }>('fs');
const here = expect.getState().testPath ?? '';
const root = here.slice(0, here.search(/[\\/]src[\\/]/));

describe("MineMuster's web pages in the app", () => {
  it('are pages on minemuster.com, over https, that the website has', () => {
    for (const url of Object.values(WEB_PAGES)) {
      const page = /^https:\/\/minemuster\.com\/([a-z-]+)$/.exec(url);
      expect(page).not.toBeNull();
      // The website serves site/<page>.html at /<page> (cleanUrls in site/vercel.json).
      expect(fs.existsSync(`${root}/site/${page![1]}.html`)).toBe(true);
    }
    expect(WEB_PAGES.privacy).toBe('https://minemuster.com/privacy');
  });

  it('are offered on the sign-in screens, on More and on Company account', () => {
    const signIn = ['auth/AuthScreen.tsx', 'auth/CompanySignInScreen.tsx'];
    for (const screen of [...signIn, 'more/MoreScreen.tsx', 'more/CompanyAccountScreen.tsx']) {
      const source = fs.readFileSync(`${root}/src/screens/${screen}`, 'utf8');
      expect(source).toMatch(/<WebPageLinks\b/);
    }
    // On a sign-in screen (a build with no server's, or the company sign-in of one that names a server),
    // it is not behind a preview setting or a step of signing in: everyone sees it before signing in.
    for (const screen of signIn) {
      const source = fs.readFileSync(`${root}/src/screens/${screen}`, 'utf8');
      const line = source.split('\n').find((l) => /<WebPageLinks\b/.test(l)) ?? '';
      expect({ screen, line: line.trim().startsWith('<WebPageLinks') }).toEqual({ screen, line: true });
    }
  });

  it('open in the browser, and say so when the phone cannot', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValueOnce(undefined);
    await expect(openWebPage(WEB_PAGES.privacy)).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith('https://minemuster.com/privacy');
    open.mockRejectedValueOnce(new Error('No browser'));
    await expect(openWebPage(WEB_PAGES.help)).resolves.toBe(false);
    open.mockRestore();
  });
});
