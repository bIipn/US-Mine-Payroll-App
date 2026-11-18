# Security scans of a private copy

MineMuster is scanned with HawkScan (StackHawk), a scanner that attacks a running app the way an outsider would. It is never pointed at the live server, at minemuster.com or at app.minemuster.com. This folder builds a copy of all three on this machine, with made-up companies and people in it, and the scanner attacks that.

| Surface | What is scanned | Address | Config, at the repository root | StackHawk environment |
|---|---|---|---|---|
| The company server | PostgREST and the `stripe-webhook` function behind a stand-in gateway, with every migration applied (`stack/`) | `https://127.0.0.1:54321` | `stackhawk-api.yml` | `Development-api` |
| The office dashboard | A build of `dashboard/` that calls the local server, served the way Vercel serves the real one (`sites/`) | `https://127.0.0.1:4444` | `stackhawk-dashboard.yml` | `Development-dashboard` |
| The website | `site/` file for file, with its one server address moved to the local server (`sites/`) | `https://127.0.0.1:4443` | `stackhawk-site.yml` | `Development-site` |

`stack/README.md` and `sites/README.md` say how each copy is made and where it differs from the live one. Read the differences before believing a finding: the gateway is a stand-in, the certificate is made here, and four of Vercel's own headers cannot be copied.

## Rules

- Nothing live is ever a scan target, and nothing a scan starts may call anything live. Every address above is on 127.0.0.1.
- Everything in the copies is made up, in the style of `supabase/tests`. Never a real person, never anything of a mine.
- Keys, passwords, the certificate, logs and scan results live in one private folder outside the repository, named with `--home` or `MINEMUSTER_SCAN_DIR`. The scripts refuse a folder inside the repository. The three configs hold no key, password or id: they read them from the environment.
- One heavy thing at a time: one scan, or one build, or one test run. A scan with its browser can use several gigabytes of memory.
- The product is HawkScan. Its results are read with `hawk op scan ...`, always with the scan's id.

## What is in this folder

- `up.mjs`: the one command. It starts everything, checks it, and runs `hawk` the way a scan has to be run here.
- `scan-inputs.mjs`: writes what the three configs read (`scan.env`), the description of the server's routes (`openapi-scan.json`) and one recorded request for each call (`api-seed.har`), from the stack's own files.
- `egress-guard.mjs`: the scan guard, a small proxy that lets the scanner reach StackHawk and nothing else outside this machine.
- `stack/`: the local server. `sites/`: the copies of the website and the dashboard, and the server that serves them.
- `test/` and `sites/test/`: tests for `node --test`. They need nothing running.

## Before the first time

- Docker, Node 22.18 or newer, `openssl`, and Chrome for the scanner's crawl.
- `npm ci` in this folder and in `dashboard/`.
- HawkScan 6 or newer (`hawk version`), and a StackHawk API key in `HAWK_API_KEY`, or in a file `key.env` in the private folder. The key is never written anywhere else.
- A StackHawk application with the three environments in the table. `hawk op app list` shows the application's id. An environment is made with `hawk op env create --app <application> Development-api`, and so on for the other two.
- The application's tech flags set to what MineMuster is made of, so the scanner does not spend its time on rules for databases and languages that are not here: `Db`, `Db.PostgreSQL`, `Language`, `Language.JavaScript`, `OS`, `OS.Linux`, `SCM` and `SCM.Git` on, and the rest off (`hawk op app tech-flags disable-all --app <application> --yes`, then `hawk op app tech-flags set --app <application> Db=true Db.PostgreSQL=true ...`). `hawk op app tech-flags enable-all` puts them back.

## Start it

```bash
export MINEMUSTER_SCAN_DIR=<a private folder outside the repository>
node scripts/security-scan/up.mjs --app-id <the StackHawk application's id>
```

The id is needed once: it is kept in `scan.env`. `up` does five things and can be run again at any time:

1. Starts the local stack and puts its data back to the seeded state.
2. Makes the two copies again from `site/` and `dashboard/` as they are now, and serves them. The copy of the contact form is given the local server's key, so the form goes through on the copy. Run `up` again after a change to either, or the scan looks at the old one.
3. Starts the scan guard.
4. Writes `scan.env`, `openapi-scan.json` and `api-seed.har` into `<private folder>/scan`. Their ids and passwords change when the stack's database is rebuilt, so `up` writes them every time.
5. Checks that a scan can start: the three addresses answer; both copies call the local server with its key; the four accounts of the server config sign in and pass the session check, and the key alone does not; every path of the description is answered by the server's own routing, and none is without its prefix; the guard lets StackHawk through and refuses another host. It then resets the stack, because signing in counts as a change.

`node scripts/security-scan/up.mjs status` says what is running, `check` runs the checks alone, `stack -- <command>` is the local stack's own command (`stack/README.md`), and `down --stack` stops everything.

To see the copies in a real browser as well, with Playwright (`sites/README.md`):

```bash
cd scripts/security-scan
node sites/check-sites.mjs --send-form --sign-in A1    # the contact form reaches the local server; a supervisor opens the company
node sites/check-sites.mjs --sign-in N1                # an account with no company gets the "Your company" page
```

It lists every host the pages asked for. It needs `MINEMUSTER_SCAN_DIR` set and both site servers running, and it leaves a contact request and sign-ins behind, so run `up` again afterwards, or `node scripts/security-scan/up.mjs stack -- reset`.

## The plan

One config for each surface, one application, one environment for each surface so each keeps its own history. They are scanned in this order, one at a time, and the checks of "After a scan" are made after each one before the next starts.

| | 1. The company server | 2. The dashboard | 3. The website |
|---|---|---|---|
| Kind | A REST API: PostgREST, and one function | A single-page app whose server is surface 1 | Static pages, and `/demo`, an app that runs in the browser and sends nothing |
| Why in this place | Every fault that leaks or changes a company's records is here | It adds how the dashboard is served, and its sign-in screen | The same as the dashboard, with no sign-in at all |
| Signing in | Email and password as JSON at `/auth/v1/token`, the access token sent as `Authorization: Bearer`. Four accounts: the supervisor of the first company gets every rule, and an employee of it, the supervisor of the second company and an account with no company get the two rules that look for one account reaching what is another's. That needs `--profile-scan-mode=primary-full --full-scan-profile=A1`, which `up.mjs scan api` adds | None. The dashboard keeps its session in the browser's storage, which the scanner cannot fill, so it sees the sign-in screen at every address. What a signed-in supervisor can do is tested on the server | None is needed |
| Routes expected | 61 method and path pairs on 28 paths. Counted from `openapi-scan.json`, which is PostgREST's own description as a signed-in account plus the webhook: 8 tables with 4 methods each, 18 functions with 27 method and path pairs between them, the description's own address, and the webhook. PostgREST lists every method on every table, so 19 of the 61 are there only to be refused by the grants | The build's 15 files, and the app itself at any other address, since every path is rewritten to it | The 43 files the copy serves: six pages, `/demo`, the 404 page and their assets |
| How the routes are found | The description file, and 38 recorded requests for what it cannot say: a table filter is written `eq.<id>`, `push_records` takes a list, and the contact form does nothing when its hidden field is filled | A crawl with a browser, 3 minutes at most, started on five addresses nothing links to | A crawl with a browser, 4 minutes at most |
| The description resolves | `up` proves it each time: all 28 paths are answered by the server's routing when asked for as the scanner builds them (the host, then the path), and each is a 404 without its prefix | Does not apply | Does not apply |

`/auth/v1` is not attacked. It is Supabase's code, and junk sent there locks the scan's own accounts out. The scanner still signs in there.

## Validate, then scan

```bash
node scripts/security-scan/up.mjs validate api         # hawk validate config, validate api, validate auth
node scripts/security-scan/up.mjs scan api             # then dashboard, then site
```

`validate` must pass before a scan, and again after any change to a config. For the dashboard and the website it is `hawk validate config` alone: they have no description file and no sign-in.

`scan` resets the stack, then runs `hawk scan --hawk-mem 4g --no-progress --json-output` on the surface's config from the repository root, with the profile mode for the server, and waits for it. It refuses to start while another `hawk` is running. What the scan prints is kept in `<private folder>/scan/<surface>/<time>-scan/`: `scan.json` (the findings), `scan.err`, `exit.code`, `run.txt` (the command, the commit, the peak memory, the hosts the guard refused), `mem.log` and `guard.jsonl`. None of it goes in the repository: the output names the StackHawk account's email address.

| Exit code | Meaning |
|---|---|
| 0 | The scan ended with no finding. The configs set `failureThreshold: low`, so any finding is 42. |
| 42 | The scan ended with findings. This is the expected code. |
| 1 | The scan failed: a config, a target that did not answer, the sign-in. If `scan.json` has no scan id, nothing was scanned. |
| 124 | The scan was stopped at its time limit, 110 minutes unless `MINEMUSTER_SCAN_MINUTES` says otherwise. Look for a `java` or `chrome` process left behind. |
| 134, 137 | The scanner ran out of memory. Give it more with `MINEMUSTER_SCAN_HAWK_MEM=6g`, with nothing else running. |

Any other `hawk` command gets the same environment with `node scripts/security-scan/up.mjs hawk -- <arguments>`, for example `hawk -- op scan get <scan id> --detail full --format json`.

An agent that runs a scan names itself in the scan's tags. Run the hawkscan skill's detection block in the same shell first, from the repository root, unchanged; it exports `HAWK_AGENT`. Without it the tag is left for `hawk` to fill in.

### After a scan

Check each scan before reading its findings as the whole truth, by its id (`run.txt`):

- Coverage: `node scripts/security-scan/up.mjs hawk -- op scan uris <scan id> --format json` against the routes expected above. Say how many were reached and list the ones that were not.
- No path was asked for without its prefix, and `/auth/v1` shows the sign-ins and nothing else.
- The sign-in held: `hawk -- op scan metrics <scan id> --format json` shows no flag for a wall of refusals, and the gateway's log (`<private folder>/stack/run/gateway.log`) has no 429 on `/auth/v1/token`.
- The stack was still up at the end (`node scripts/security-scan/up.mjs stack -- status`), and its `Data` line says which tables the scan changed.
- `run.txt` names no host refused by the guard, or the ones it names are understood.

Two answers look like trouble on the server and are not an attack getting through. A function that refuses a caller answers 500 with `P0002` ("No such company."): that is a real, small fault to fix, not a leak. A table the account may not read answers 200 with `[]`: that is row level security refusing.

### After a fix

Run `up` again so the copies and the stack hold the fix, validate, then:

```bash
node scripts/security-scan/up.mjs rescan api <the id of that surface's first full scan>
```

A rescan runs only the rules that found something, so it proves a fix and finds nothing new. Always give the id of the first full scan, never of an earlier rescan. A fix that adds a table, a function or a page needs a full scan instead.

## How a scan is kept on this machine

Three things, each checked:

- The copies name no live server. `sites/stage.mjs` stops if the live server's address, or any other Supabase project's, is anywhere in a copy.
- The scanner attacks the one host its config names, and each config's host is on 127.0.0.1. A test holds the three configs to that.
- The scan guard. The copies still link to the live website, the live dashboard and Stripe, because they are copies, and a crawl follows links. So every `hawk` command `up.mjs` runs is given `egress-guard.mjs` as its only proxy: for the launcher, for the scanner's Java side and for a browser that reads the environment. The guard passes HTTPS to `api.stackhawk.com`, `auth.stackhawk.com` and `download.stackhawk.com` and answers 403 to everything else, whatever the machine's own network would allow. Each request is a line in `<private folder>/run/guard.jsonl`, and each scan keeps its own lines and lists the hosts that were refused. `up.mjs` runs no `hawk` command while the guard is down.

Do not run `hawk scan` on these configs by hand without the guard.

## What these scans do not reach

- The dashboard behind its sign-in. The crawl never sees a company's records drawn on a page. `sites/check-sites.mjs --sign-in` opens the signed-in dashboard with no policy violation, and that is all that is checked there.
- The webhook after its signature check. The scanner cannot sign a request. `supabase/tests` covers what a signed event does.
- Steps that happen once: joining, approving, denying, releasing. The scanner's first call that succeeds uses the state up. The database tests walk every state.
- An employee's own writes with every rule. Only the supervisor's account gets the whole policy.
- Limits by rate. No rule looks for a missing one, and `supabase/README.md` names the ones still to add.
- Supabase's own gateway, Supabase Auth, Cloudflare, Vercel's edge and the live certificates. A finding about one of them here is about the stand-in.

## Tests

```bash
cd scripts/security-scan
node --test "test/*.node.mjs"          # the guard, the scan inputs, and that no config holds a key or scans anything but this machine
node --test "sites/test/*.node.mjs"    # the rules the site server follows
```
