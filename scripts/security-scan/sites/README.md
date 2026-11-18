# Private copies of the website and the dashboard, for a security scan

A security scanner is never pointed at minemuster.com, at app.minemuster.com or at the company server. It is pointed at copies on this machine. This folder makes the copies of the two web surfaces and serves them the way Vercel serves the real ones:

| Copy | Made from | Served at |
|---|---|---|
| The website | `site/`, file for file | `https://127.0.0.1:4443` |
| The office dashboard | a build of `dashboard/` | `https://127.0.0.1:4444` |

Both call one server and no other: the local copy of the company server at `https://127.0.0.1:54321`, which `../stack` runs.

Everything that is made goes in a private folder outside the repository, named with `--home` or `MINEMUSTER_SCAN_DIR`. The scripts refuse a folder inside the repository. Nothing here is part of the app, the dashboard or the website, and none of it is deployed.

## The pieces

- `stage.mjs` makes the two copies and writes what it did to `<home>/sites/stage-report.json`.
- `serve-vercel.mjs` serves a folder over HTTPS on 127.0.0.1, going by a `vercel.json`.
- `vercel-rules.mjs` holds the rules the server follows, as functions that open no file and no socket.
- `layout.mjs` knows where the copies live, the three local addresses and which certificate to use.
- `check-sites.mjs` opens the copies in a browser and checks them.
- `compare-with-vercel.mjs` checks the rules against Vercel's own routing code.
- `test/` holds the tests, for `node:test`. Their names end in `.node.mjs` and not in `.test.mjs`, so the app's jest does not pick them up.

The one dependency is `path-to-regexp` 6.3.0, in `../package.json`. Vercel reads a `source` in `vercel.json` with path-to-regexp 6, which takes a regular expression in brackets, the negative lookahead for the demo included. Later versions of the package do not.

## Commands

```bash
cd scripts/security-scan && npm ci                       # once
export MINEMUSTER_SCAN_DIR=<a private folder outside the repository>

node sites/stage.mjs                                     # make both copies (--only website, --only dashboard)
node sites/serve-vercel.mjs                              # serve both; --site website or --site dashboard for one
node sites/check-sites.mjs                               # the browser check; needs both servers running
node --test "sites/test/*.node.mjs"                      # the tests; they need nothing running
```

`serve-vercel.mjs` reads the files once, when it starts, so start it again after `stage.mjs` has run again. `--log <file>` writes one line for each answer. To serve any other folder: `--root <folder> --config <vercel.json> --port <port> --cert <file> --key <file>`.

`check-sites.mjs` needs Playwright, which is not a dependency of this folder. It looks for it in `NODE_PATH`, or where `--playwright <folder>` says. The browser is started so that it can reach 127.0.0.1 and nothing else. Two more checks need the local server running: `--send-form` sends the contact form once, with made-up details, and `--sign-in` signs in to the dashboard copy as one of the local server's made-up accounts.

The servers use the certificate the local server's step made (`<home>/stack/tls`), so one certificate covers the three addresses. With none there, `layout.mjs` makes one of its own in `<home>/sites/tls`. Either is self-signed: a client has to be told to trust the file or to skip the check.

## What `stage.mjs` changes

The live server's address is read from `connect-src` in the two `vercel.json` files. The script moves exactly one address and stops if the files name none or more than one.

**The website.** Every file of `site/` is copied as it is, but two. In `contact.js` and in `vercel.json` the live server's address becomes `https://127.0.0.1:54321`, once in each. The script then checks its own work. If any of this fails it stops with an error and takes the copy away, so a copy is whole and checked or it is not there:

- the copy holds the same files as `site/`, and all but those two are the same byte for byte;
- those two differ from `site/` by the address and nothing else;
- in each Content-Security-Policy every directive is as it was, in the same order, except the one address in `connect-src`;
- the live server's host, or any other Supabase project's, is named nowhere in the copy.

The policy for the pages carries the hashes of their inline scripts. No page is changed, so no hash can break, and the script shows it: it works out the hash of every inline script a browser would run on every page and looks for it in the `script-src` that page is served with. The home page has two (the line that marks the page as having JavaScript, and the import map); the other pages have the first alone; `/demo` is served with `'unsafe-inline'`.

The contact form sends the live server's publishable key, and the local server turns that key away, so on the copy the form says the message did not go through. `--local-key` also gives the copy's `contact.js` the local server's key, read from `<home>/stack/env.json`, and then the form goes through. Without it, the address is the only thing changed.

**The dashboard.** `vite build` is run in `dashboard/` with `--outDir <home>/sites/dashboard`, `VITE_SUPABASE_URL=https://127.0.0.1:54321` and `VITE_SUPABASE_PUBLISHABLE_KEY` set to the local server's key. `dashboard/dist` is not touched. The dashboard takes any address `supabase-js` takes, and its build refuses only a secret key (`isSecretKey`), so the local values are accepted as they are. Until the local server's step has written its key, the build is made with a placeholder that opens nothing, and the script says what is missing.

The copy of `dashboard/vercel.json` is written beside the build, as `<home>/sites/dashboard.vercel.json`, because Vercel's build output has no `vercel.json` in it. Its `connect-src` is moved the same way and checked the same way.

The built code must not name the live server, and the script stops and takes the build away if it does. The source maps do: they carry the source files as text, and `src/lib/config.ts` names the live server as the default. That text is moved as well, so the host is nowhere in the copy.

**Links are left as they are.** The pages still link to `app.minemuster.com`, `minemuster.com` and Stripe's billing pages, and the report lists every host a copy names. No page loads anything from them. A crawler that follows every link would leave the copy, so the scanner has to be told to stay on 127.0.0.1.

## How the server decides

The order is the one Vercel's own build gives a `vercel.json` (`getTransformedRoutes` in `@vercel/routing-utils`):

1. A path that cannot be read is answered 400. A path with doubled slashes is sent to the same path with single ones.
2. With `cleanUrls`, `/pricing.html` is sent to `/pricing`, and `/index.html`, `/index` and `/demo/index.html` to their folders, with a 308.
3. Every header rule whose `source` matches the path adds its headers. A later rule's value takes the place of an earlier one's. The match is against the path as it was asked for, even when the answer is another file.
4. The file for the path is looked up in the list of the site's files, read when the server started: the file itself, the page without its ending (`cleanUrls`), or the folder's `index.html`. A last slash changes nothing. A folder lists nothing. `vercel.json`, `.env*` and `.git/` are never served.
5. With no file, the first rewrite that matches and names a file that is there is served, with status 200. That is how every path of the dashboard is the app.
6. With nothing still, the website answers with its `404.html` and status 404. A path that starts with `/api` gets a plain 404 instead, as on Vercel.

A `vercel.json` with anything this server would have to guess at (`redirects`, `trailingSlash`, `routes`, `has`, a named part of a path) is refused when it starts.

## Compared with the live sites

On 18 November 2026 each of these was asked for once, as an ordinary page view, through Vercel's own fetch tool: `https://minemuster.com/`, `/pricing`, `/demo` and `https://app.minemuster.com/`. Nothing else live was touched. Each answered 200. The ETag of each is the MD5 of the file in this repository (`site/index.html`, `site/pricing.html`, `site/demo/index.html`, `dashboard/dist/index.html`), so the live sites serve these files.

The same four paths were then asked of the copies with the same `Accept-Encoding`, and the headers compared name by name:

| Header | Vercel | The copy |
|---|---|---|
| `Content-Security-Policy`, `Permissions-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Strict-Transport-Security`, `X-Robots-Tag` (demo), `Cross-Origin-Opener-Policy` (dashboard) | from `vercel.json` | the same values, but for the one address in `connect-src` |
| `Cache-Control: public, max-age=0, must-revalidate` | sent | the same |
| `Access-Control-Allow-Origin: *` | sent | the same |
| `Content-Disposition` | `inline` for `/`, `inline; filename="pricing"`, `inline; filename="demo"` | the same |
| `Content-Type: text/html; charset=utf-8` | sent | the same |
| `Content-Encoding: br`, `Transfer-Encoding: chunked` | sent | the same |
| `ETag` | `W/"<MD5 of the file>"` | the same for the website; the dashboard's differs, because its build names another script |
| `Last-Modified` | when it was deployed | when the file was last changed |
| `Date` | sent | sent |
| `Server: Vercel` | sent | **not sent** |
| `X-Vercel-Id` | sent | **not sent** |
| `X-Vercel-Cache` | sent (`HIT` or `MISS`) | **not sent** |
| `Age` | sent | **not sent** |

The copy sends no header on those four paths that Vercel does not. So a finding about a header that is missing from the copy is real, unless it is one of the four in bold. A finding about `Server`, a `X-Vercel-` header or `Age` cannot come from the copy at all: it has to be judged against the live answer.

`Access-Control-Allow-Origin: *` is Vercel's own, on every static file. It is in neither `vercel.json`. A finding about it is true of the live sites.

### What the copy does that was not seen live

Four page views do not show everything. These were read in Vercel's code instead (`@vercel/routing-utils` 6.6.1 and the `vercel` command line 41.0.0, from npm), and the copy follows them:

- the order above, the expression each `source` becomes, the two `cleanUrls` redirects, and the check that a rewrite's file is there. `compare-with-vercel.mjs` puts the route table Vercel's package makes of each `vercel.json` beside the one this server follows; they are the same, 8 routes for the website and 4 for the dashboard;
- that a later header rule's value takes the place of an earlier one's (neither file has two rules that set the same header for one path);
- which files are never served, and the 404 page for every path but `/api`;
- `Redirecting...` as the text of a redirect, and the default `Cache-Control` on it;
- that a rule matches a path with its capitals as written. This is what Vercel's development server does, and it is not proof of what the live edge does.

These are from Vercel's documentation, or are a guess, and nothing here checked them. A finding that rests on one of them needs a look at the live site before it is believed:

- a redirect's `Refresh` header, its `text/plain` type, and `Strict-Transport-Security: max-age=63072000` on it (Vercel's default for a custom domain; no rule reaches a redirect);
- a path with doubled slashes being sent to the single-slash path, and a path being percent-decoded before it is matched;
- a page being served the same with a last slash (the documentation says so for a site with no `trailingSlash` setting);
- 405 with `Allow: GET, HEAD` for any other method, carrying the headers of the rules, and 400 for a path that cannot be read;
- `Content-Disposition` and `Content-Type` for anything but the four pages (`inline; filename="site.css"`, `application/javascript; charset=utf-8` and so on);
- the 404 page carrying `Access-Control-Allow-Origin: *` and `Content-Disposition: inline; filename="404"`.

### What Vercel does that the copy does not

- HTTP/2 and HTTP/3. The copy speaks HTTP/1.1 only.
- Its own TLS settings and certificate. A finding about the certificate or the protocol versions is about this machine.
- A redirect from plain HTTP to HTTPS, and from one host name to another. The copy has no plain HTTP port.
- Range requests. The copy sends the whole file.
- Its caches, its firewall and its protection against floods. Nothing limits requests to the copy.
- `X-Vercel-Error` on its own 404 page.

## What was checked, and how

- `node --test "sites/test/*.node.mjs"`: 27 tests. Every `source` in the two files becomes the expression Vercel makes of it and matches the paths it should and no others, the negative lookahead included; every path on the website gets exactly one policy; redirects never leave the site; nothing outside the list of files can be asked for; and the server's own answers, over HTTP on a free port, with made-up files.
- `compare-with-vercel.mjs`, with Vercel's package installed in the private folder: the same route tables.
- `check-sites.mjs`, in Chromium: the seven pages of the website load with no policy violation, no failed request and no error; the 3D logo draws; `/demo` opens the app; a path that is not there gives the 404 page with status 404; `/pricing.html` ends at `/pricing`; the dashboard shows its sign-in screen at `/`, at a deep link and at `/?start=trial`. Every request went to `127.0.0.1:4443` or `127.0.0.1:4444`.
- With `--send-form`, the contact form's one request went to `127.0.0.1:54321`. The local server turned it away, as it does the live key; in a copy made with `--local-key` it took the message.
- With `--sign-in`, the dashboard copy signed in as the made-up supervisor of the local server's first company and opened its Overview, with no policy violation and no failed request. Every request went to `127.0.0.1:4444` or `127.0.0.1:54321`.

Not checked: the copies in any browser but Chromium.
