// The website's Content-Security-Policy (site/vercel.json) lets a page run its own script files and
// the inline scripts named by their SHA-256 hash, and nothing else. A rebuilt page whose inline
// script changes needs its new hash in the policy, or the browser refuses to run it; a policy that
// allows any inline script ('unsafe-inline') lets in a script nobody wrote. This holds the policy of
// each page to the inline scripts that page really has.

// This project has no Node types, so the two modules are asked for by name with the calls used here.
type Files = { readdirSync(dir: string): string[]; readFileSync(file: string, encoding: 'utf8'): string };
type Hashes = { createHash(kind: 'sha256'): { update(data: string, encoding: 'utf8'): { digest(as: 'base64'): string } } };
const fs = jest.requireActual<Files>('fs');
const crypto = jest.requireActual<Hashes>('crypto');

const here = expect.getState().testPath ?? '';
const site = `${here.slice(0, here.search(/[\\/]scripts[\\/]/))}/site`;

type Rule = { source: string; headers: { key: string; value: string }[] };
const rules = (JSON.parse(fs.readFileSync(`${site}/vercel.json`, 'utf8')) as { headers: Rule[] }).headers;

/** The script-src of the policy Vercel sends for a path, as a list of sources. */
function scriptSrc(source: string): string[] {
  const rule = rules.find((r) => r.source === source);
  const policy = rule?.headers.find((h) => h.key.toLowerCase() === 'content-security-policy')?.value;
  if (!policy) throw new Error(`site/vercel.json sends no Content-Security-Policy for ${source}`);
  const directive = policy.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src '));
  if (!directive) throw new Error(`The policy for ${source} has no script-src`);
  return directive.split(/\s+/).slice(1);
}

/**
 * Whether a script element is run as a script at all. One whose type is not JavaScript, "module" or
 * "importmap" is a data block (the pages' application/ld+json for search engines): the browser
 * never runs it, and the policy does not apply to it.
 */
function runs(attributes: string): boolean {
  const type = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1]?.toLowerCase();
  return type === undefined || ['module', 'importmap', 'text/javascript', 'application/javascript'].includes(type);
}

/** The hash a browser checks for each inline script of a page: SHA-256 of the text between its tags, in base64. */
function inlineScriptHashes(file: string): string[] {
  const html = fs.readFileSync(file, 'utf8');
  return [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .filter(([, attributes = '']) => !/\ssrc\s*=/.test(attributes) && runs(attributes))
    .map(([, , body]) => `'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`);
}

const pages = fs.readdirSync(site).filter((name) => name.endsWith('.html'));

describe('the website runs only the inline scripts its policy names', () => {
  it('names every inline script of each page by its hash', () => {
    const main = scriptSrc('/((?!demo(?:/|$)).*)');
    for (const page of pages) {
      for (const hash of inlineScriptHashes(`${site}/${page}`)) expect({ page, allowed: main.includes(hash) }).toEqual({ page, allowed: true });
    }
  });

  it('names the demo page\'s inline script by its hash, on both of its paths', () => {
    const hashes = inlineScriptHashes(`${site}/demo/index.html`);
    expect(hashes.length).toBeGreaterThan(0);
    for (const source of ['/demo', '/demo/(.*)']) for (const hash of hashes) expect(scriptSrc(source)).toContain(hash);
  });

  it('lets no page run an inline script by allowing them all', () => {
    for (const source of ['/((?!demo(?:/|$)).*)', '/demo', '/demo/(.*)']) {
      expect(scriptSrc(source)).not.toContain("'unsafe-inline'");
      expect(scriptSrc(source)).not.toContain("'unsafe-eval'");
    }
  });
});
