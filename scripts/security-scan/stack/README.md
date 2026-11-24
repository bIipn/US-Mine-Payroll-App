# The local scan stack

A private copy of MineMuster's server, on this machine alone, for a security scanner to attack and for the crew sign-in to be tried against the real Supabase Auth before anything goes live. It is built from the same parts the live server is: Supabase's own PostgreSQL image, Supabase Auth and PostgREST, with every migration in `supabase/migrations` applied in order, and the repository's own edge functions (`stripe-webhook`, `crew-auth`, `supervisor-tools` and `delete-account`). In front of them is a small gateway that stands in for Supabase's.

Nothing here talks to the live project, to minemuster.com or to Stripe, and nothing live is ever a scan target. Every company, person and record in the stack is made up, in the style of `supabase/tests`. The repository is public: keep it that way.

## Commands

Name a private folder outside the repository first. The stack keeps its secrets, its certificate, its logs and its reports there, and refuses a folder inside the repository.

```bash
export MINEMUSTER_SCAN_STACK_DIR=/path/to/a/private/folder
node scripts/security-scan/stack/stack.mjs start      # everything up, migrated and seeded
node scripts/security-scan/stack/stack.mjs status     # what runs, whether the data is as seeded, memory
node scripts/security-scan/stack/stack.mjs reset      # the data back to the seeded state
node scripts/security-scan/stack/stack.mjs stop       # everything down, the database kept
node scripts/security-scan/stack/stack.mjs token A1   # a fresh access token for a made-up account
node scripts/security-scan/stack/stack.mjs smoke      # a round of checks through the gateway
node scripts/security-scan/stack/stack.mjs crew-e2e   # the crew sign-in end to end, against the real Supabase Auth
node scripts/security-scan/stack/stack.mjs describe   # write the OpenAPI files and routes.md again
```

They need Docker, Node 22.18 or newer and `openssl`, and no npm package. Every SQL statement goes through `psql` inside the database container.

- `start` can be run again at any time: it starts what is not running and leaves the rest. The first start makes the secrets and the certificate, builds the database, applies the migrations, seeds, takes a snapshot and writes `env.json`, `fixtures.json`, the OpenAPI files and `routes.md`. It took 11 seconds here with the images already pulled, and 3 seconds after a `stop`.
- `reset` empties every table of the schemas `public`, `auth`, `vault` and `supabase_migrations` and loads the snapshot again, in one transaction, with triggers and foreign keys off for that session (which is how it gets past the trigger that keeps `record_history`). It then restarts Supabase Auth, which keeps its request limits in memory. It compares a digest of every row before and after, says whether the data is the seeded state, and exits 1 if it is not. It took 1.5 seconds here.
- `reset --hard` throws the database away and builds it again. Use it if a scan could have changed something a reset does not put back: a role, a grant, a function, a table.
- `stop --purge` removes the containers and the database with them. The keys and the certificate are kept, so a site built for this stack still fits after the next `start`. The ids, passwords and join codes in `fixtures.json` are new after it.
- `MINEMUSTER_SCAN_AUTH_LIMITS=off` on the first `start` (or after `stop --purge`) runs Supabase Auth without its limits by caller address.
- `crew-e2e` (also `node scripts/security-scan/stack/crew-e2e.mjs`) wants a stack just started or reset, and stops if it is not; it changes the data and spends Supabase Auth's sign-in limit for 127.0.0.1, so run `reset` after it. It took 8 seconds here. See [The crew sign-in end to end](#the-crew-sign-in-end-to-end).

## What runs

Everything listens on 127.0.0.1 only. A scanner uses the gateway's port and no other.

| Piece | Port | What it is here | What the live server runs |
|---|---|---|---|
| Gateway | 54321, HTTPS | `gateway.mjs`, under Node | Supabase's hosted gateway, behind Cloudflare |
| PostgreSQL | 54322 | `supabase/postgres:17.12.0.000`, container `mm-scan-db` | The same version, 17.12.0.000 (read from the project's settings, not from the database) |
| PostgREST | 54331 | `postgrest/postgrest:v14.18`, container `mm-scan-rest` | Not known. 14.18 is the version Supabase pins in its own self-hosted stack |
| Supabase Auth | 54332 | `supabase/gotrue:v2.198.0`, container `mm-scan-auth` | Not known. 2.198.0 was the newest on Docker Hub; Supabase's self-hosted stack pins 2.197.0 |
| Edge functions | 54333 | `functions-server.mjs`, under Node, running the `handler.ts` of `stripe-webhook`, `crew-auth`, `supervisor-tools` and `delete-account` | The same files, with their `index.ts` and `_shared`, on Supabase's edge runtime (Deno) |

The containers share the host's network, because this machine's Docker has no bridge. `MINEMUSTER_SCAN_DB_IMAGE`, `MINEMUSTER_SCAN_REST_IMAGE` and `MINEMUSTER_SCAN_AUTH_IMAGE` name other images.

The database is built the way a Supabase project is. The image makes the roles (`anon`, `authenticated`, `service_role`, `authenticator`, `postgres` and the rest), the schemas, Vault and the default privileges on `public` by itself. Supabase Auth then makes its own tables. Each migration is applied as `postgres`, which is not a superuser there, in one transaction, and written into `supabase_migrations.schema_migrations`, as `supabase db push` does. The webhook's signing secret is a made-up `whsec_` value kept in Vault as `stripe_webhook_secret`, and the function reads it from there.

PostgREST serves the schemas `public` and `graphql_public`, with at most 1000 rows an answer and `public, extensions` as the extra search path. Supabase Auth has email and password sign-in on, "confirm email" off and no other provider, and the dashboard's invite link (`https://app.minemuster.com/?invited=1`) on its redirect list, as `supabase/README.md` has the owner add it to the live project. Access tokens are signed with an EC key (ES256), as a project with publishable and secret keys signs them, and last an hour.

Each edge function is given what Supabase gives every one, made from the stack's own secrets: `SUPABASE_URL` (the gateway's address), `SUPABASE_SECRET_KEYS` and `SUPABASE_PUBLISHABLE_KEYS`. So each reaches PostgREST and Supabase Auth through the gateway, as the deployed ones do, with the server key in `apikey` alone. Every call a function makes to Supabase Auth is noted in `run/auth-calls.jsonl`, which `crew-e2e` reads. The scan's own descriptions (`openapi-stripe-webhook.json`, and `scan-inputs.mjs` above this folder) still name the webhook alone: a scan is not pointed at the other three unless it finds them.

## What it writes

All of it in `MINEMUSTER_SCAN_STACK_DIR`, readable by its owner only:

| File | What it holds |
|---|---|
| `env.json` | The gateway's address, the publishable key, the ports, and the path of every other file |
| `fixtures.json` | Every made-up id, email address and password, both keys, the webhook's signing secret, and how to get a fresh access token |
| `secrets.json` | The stack's own secrets: the database password, the signing keys, the two API keys |
| `tls/cert.pem`, `tls/key.pem` | A self-signed certificate for `127.0.0.1` and `localhost`, which is its own authority: trust the file itself (`curl --cacert`, `NODE_EXTRA_CA_CERTS`). Another site served for the scan can use the same pair |
| `snapshot.sql`, `snapshot.digest` | The seeded data and the digest a reset is checked against |
| `openapi-anon.json`, `openapi-authenticated.json` | PostgREST's own description as each role |
| `openapi-anon.gateway.json`, `openapi-authenticated.gateway.json` | The same, with the gateway's address and `/rest/v1` as the base path |
| `openapi-stripe-webhook.json` | A small description of the webhook, written by hand |
| `routes.md` | Every table, view and function `anon` and `authenticated` reach, with counts and cross-checks |
| `smoke.txt` | The last round of `smoke` |
| `crew-e2e.txt`, `crew-e2e.json` | The last run of `crew-e2e`: every check, every call made to Supabase Auth and how each answer compares with the stand-ins. No token, key, password, passcode, reset code or id |
| `run/` | The containers' settings, the logs of the gateway and the functions server, and their process ids |
| `run/auth-calls.jsonl` | One line for each call a function made to Supabase Auth: the function, the method, the path with any id taken out, the query's parameter names, and what Auth answered: its status, the shape of its body (each key and the type of its value) and its `error_code`. Never a value |

## The made-up data

`seed.mjs` makes it the way the product does, through the gateway: five accounts sign up with Supabase Auth; two of them start a company with `create_company`; one supervisor adds two roster rows through the API, and one person joins with the code and her name (`join_company`); another asks to join under a name that is not on the roster, which leaves a pending request; Stripe's two events for a trial arrive at the webhook, signed; the phones send their records with `push_records`; and a visitor sends the contact form. One thing is done as the project's owner does it in the SQL editor: letting the second company in without paying.

| Label | Who | Where |
|---|---|---|
| A1 | Sam Ortiz, supervisor | Test Pit A, which he started. It has a trialing subscription |
| A2 | Riley J Quinn, employee | Test Pit A, joined |
| A3 | Lee "Buck" Vance III | On Test Pit A's roster, with no account on the row |
| B1 | Ana Diaz, supervisor | Test Pit B, which she started. It is let in without paying |
| N1 | Jo Vale | An account that has joined nothing |
| P1 | Kit Marlow | An account with a pending request to join Test Pit A |

Test Pit A holds one record of each of the eleven kinds `push_records` takes; Test Pit B holds four. The four kinds every phone reads (settings, people, units and area sheets) are written in the shape the server checks before it takes them, and `supabase/tests/scan_seed.db.mjs` holds the seed's records to that: one set aside stops the seed.

## How the gateway behaves, and where that comes from

`gateway.mjs` follows two things Supabase publishes. Nothing live was looked at to write it.

- Supabase's API key guide: a publishable key with no user token is `anon`, with a user's access token it is that user, and a secret key is `service_role`; a secret key from a browser (by its `User-Agent`) is always answered 401; a key repeated in `Authorization` counts as no user token only when it equals `apikey`.
- The gateway configuration of Supabase's self-hosted stack (`docker/volumes/api/envoy/lds.template.yaml` in `supabase/supabase`), whose documentation says its CORS policy matches the platform: the routes and which of them need a key; the key taken from the `apikey` header or the `apikey` query parameter; PostgREST's description at exactly `/rest/v1/` for the secret key alone; `/functions/v1/` reached with no key, where a key that starts with `sb_` is still looked up; preflights answered by the gateway with any origin, the nine methods, any header and a max age of 3600; a path with an escaped slash or a header name with an underscore refused; `X-Forwarded-For` added to, not replaced.

## What differs from the live server

Each of these could hide a finding the live server has, or invent one it does not. A finding that touches one of them is checked by a person against the live server before it is counted.

| Difference | What it could hide or invent |
|---|---|
| The gateway is a stand-in written from documentation. The refusal texts for a missing, unknown or misused key are from memory of the platform, and of its response headers only the two below are known. | Any finding about response headers, CORS, the wording or status of a refusal, or how odd requests are parsed (HTTP/2, request smuggling, very long headers) says something about this stand-in, not about Supabase's gateway. |
| No Cloudflare in front: no web application firewall, no bot rules, no limit by address at the edge, HTTP/1.1 only. | Invents findings Cloudflare would block or throttle, such as fast guessing of join codes. Hides anything specific to HTTP/2 or HTTP/3. |
| The certificate is self-signed, for 127.0.0.1. | Invents every certificate finding. Says nothing about the live certificate or TLS settings. |
| The edge functions run under Node 22, which strips their types, behind a small router, not on Supabase's edge runtime (Deno): each `handler.ts` is the deployed one, and its `index.ts`, which hands it to `Deno.serve`, is not run. Their calls go out by Node's `fetch`. A body over 20 MB is refused here before a function sees it; each function caps its own body below that (`crew-auth` 4 KB, the other two 16 KB). | Hides anything in the runtime itself: its limits on size, wall-clock and CPU time and memory, its own error pages and headers, and how Deno's `fetch` differs from Node's. The handlers' own answers are the real ones, and so are Supabase Auth's and PostgREST's to them. |
| `crew-auth` counts requests by `cf-connecting-ip`, else the first entry of `X-Forwarded-For`. This gateway passes a client's own `cf-connecting-ip` on as it came, and puts the connection's address after a client's own `X-Forwarded-For`: so here a client chooses the address `crew-auth` counts, with either header, and gets past its limit of 30 (`crew-e2e`, flow 8). | Could invent a finding the live server does not have, if Supabase's edge sets `cf-connecting-ip` from the connection, or hide one it has. Which it is was not looked at here: it is a check to make once deployed (`supabase/README.md`, "Checks to make once it is deployed"). |
| PostgREST and Supabase Auth may not be the versions the live server runs, and their settings beyond those named above are the images' defaults. | A finding in one version may not be in the other. Supabase Auth's limits, password rules and mail settings on the live project are whatever its dashboard says. |
| No mail is sent: no SMTP server is set, so Supabase Auth uses its noop mail client (its log says so at start). An invite is answered 200 as if its email had gone: the account is made, `invited_at` and `confirmation_sent_at` are set and the link's token is kept, and nothing about mail is logged (`crew-e2e`, flow 6). `crew-e2e` opens the link the email would carry, made from that token (`auth.users.confirmation_token`). Password recovery, magic links and email changes were not tried. | Hides everything about delivery: an address the live mail server refuses, a bounce, the email's wording, and Supabase's limit on emails sent. |
| Supabase Auth's limits by caller address are on, keyed on a header this gateway sets from the connection. Every call here comes from 127.0.0.1: a scanner's sign-ins, `crew-e2e`'s, and the password grants the functions make. | About thirty sign-in attempts in a burst stop every sign-in from this machine (429) until the limit refills or a reset; `crew-e2e` spends it on purpose (flow 9). On the live server a client's own sign-ins count against its own address, so one scanner locks out only itself; every password grant `crew-auth` makes comes from the function's own address there too, so all crews share that one limit (`supabase/README.md`, "Checks to make once it is deployed"). |
| Storage, Realtime, the logs and the database's pooler are not run. `/storage/v1/` and `/realtime/v1/` answer 404 here. | Hides everything in those services. The app does not use them yet. |
| `pg_graphql` is off, as the image leaves it, so `/graphql/v1` answers "pg_graphql extension is not enabled". | If someone turned GraphQL on in the live project, its whole surface is missing here. |
| The database trusts every connection from 127.0.0.1 (the image's own `pg_hba.conf`), and its ports are open to anything on this machine. | Nothing through the gateway. A scanner must not be pointed at ports 54322 to 54333. |
| PostgREST's `openapi-mode` is its default, so a description lists only what the asking role reaches. | Only matters for the description files; the live gateway gives the description to the secret key alone. |
| The data is small, made up and a few minutes old. | Hides anything that needs volume, time passing (a trial ending) or a second free trial. |

## The crew sign-in end to end

`crew-e2e.mjs` acts out the crew sign-in and the supervisor tools through the gateway, the way the app, the dashboard and a supervisor act them out, against the real Supabase Auth and PostgREST, and checks what each step leaves in the database and in Supabase Auth's admin API. Before a deploy, run it on a stack just started or reset, and `reset` after it. Every name in it is made up, and every address it makes up is at example.com.

| Flow | What it acts out |
|---|---|
| 0 | Sam Ortiz, the seed's supervisor, signs in and puts Lee Park, Maria De La Cruz and Pat Cole (crew) and Dana Hollis (a supervisor's row) on Test Pit A's roster, through PostgREST |
| 1 | `crew-auth` `lookup` with the publishable key alone, as the app sends it |
| 2 | `sign_up` for Lee Park: a session; in Auth, a confirmed account at `crew-<32 hex>@crew.minemuster.com` with `app_metadata.sign_in` of `passcode`; a `crew_logins` row with the digest alone; the account on his row. `sign_up` again: `already_signed_up` |
| 3 | `sign_in`, then wrong passcodes: 4, 3, 2 and 1 tries left, then locked for 15 minutes; the lock's end is moved into the past by SQL, and the 10th locks the account until a reset |
| 4 | Sam makes a reset code (`make_passcode_reset_code`); a wrong code, then `reset` with the right one; the sessions made before it can no longer refresh |
| 5 | `confirm`, then `delete-account` with the fresh session, with no Origin as the phone sends it: the account, its `crew_logins` row and its sessions go; its roster row and a shift it sent stay, the link to it cleared |
| 6 | `supervisor-tools` with the dashboard's Origin: a preflight, another site's page refused, `invite` of a new address (Auth makes the account), `invite` of a confirmed address (no call to Auth's invite), `resend`, and `delete_crew_sign_in` |
| 7 | Dana opens the invite email's link (the first email's link, after Send again, has run out), chooses a password, signs in and accepts; Pat, a crew member, accepts with his email account, and his passcode account is let go of with a released hold |
| 8 | The limit of 30 `crew-auth` requests from one address in 10 minutes, and which address is counted with a client's own `X-Forwarded-For` or `cf-connecting-ip` |
| 9 | Supabase Auth's own limit: password grants until it answers 429; then a `sign_up` answers `busy` and deletes the account it made again |

Every call made to Supabase Auth, by a function or by the script, is kept as its status, the shape of its body and its `error_code`, and compared with what `supabase/tests/stand-ins.mjs` answers the same call, which the functions' tests run against. A difference in the status, the `error_code` or a key a function reads fails the run; keys only Auth sends are listed. Calls the stand-ins do not play (a refresh, a sign-up, the admin API's reads, the invite link) are listed with what came back.

## What is not known

These could not be learned without a request to the live project, which this job never makes. One `curl -sI` of the live project's `/rest/v1/` by its owner, and one preflight, would settle most of them.

- Which response headers the hosted gateway adds, beyond two. One read of the live API's headers, for the security review of November 2026, showed `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` and `X-Content-Type-Options: nosniff`. This gateway sends both on every answer: its own refusals, its preflights, its 400 for a request it cannot parse, and every answer it passes on, in place of any the service sends (`test/gateway.node.mjs` checks each kind). It also takes away the `Server` header of the service behind it, since Cloudflare puts its own there. It adds no `Content-Security-Policy` or `X-Frame-Options`. The self-hosted gateway does add a sandboxing `Content-Security-Policy` to `/rest/v1`, `/storage/v1` and `/functions/v1`, for a reason of its own (its dashboard shares the address); whether the platform does, and what else it adds, is not known. The list is `PLATFORM_HEADERS` at the top of `gateway.mjs`.
- The exact CORS headers. This gateway answers as the self-hosted one does: it repeats the request's `Origin` in `Access-Control-Allow-Origin` and exposes every header. Supabase Auth adds `Access-Control-Allow-Credentials: true` by itself, so its answers carry both. The platform may send `*` instead, and may drop the credentials header.
- The status and body the platform gives the publishable key at `/rest/v1/` (here 403 `RBAC: access denied`, as the self-hosted gateway), and what it does with an `sb_` key in `Authorization` that differs from `apikey` (here it is passed on, and the service refuses it as not a token).
- Whether the platform checks a key's checksum before it looks the key up. Here any unknown key is "Invalid API key".
- Whether the platform hands the first entry of a client's own `X-Forwarded-For` on to the database. Here it does, as Cloudflare and Envoy are documented to: the contact form's limit for each sender can then be sidestepped by sending a new header each time, which `supabase/README.md` already names as what is left.
- The live project's Supabase Auth settings: its limits, its site address and redirect list, its password rules, and whether the legacy JWT keys are still accepted.
- Whether `pg_graphql` is on in the live project (Database, then Extensions, in Supabase's dashboard). Here the image has it (1.6.3) but it is not installed, so `/graphql/v1` answers "pg_graphql extension is not enabled". If it is on in the live project, the live server answers a whole GraphQL surface over the tables that this stack does not have: the stack should then run `create extension pg_graphql` after the migrations, and the server's scan should be given `app.graphqlConf`.
- How the live project signs access tokens (Auth, then JWT signing keys). Here Supabase Auth signs them ES256, and PostgREST also takes an HS256 token signed with the stack's own legacy secret (seen on 18 November 2026, calling `my_companies` as A1: the ES256 token as issued, 200; the same claims signed HS256 with the legacy secret, 200; `alg: none`, a wrong secret or a changed expiry, 401). A reviewer's read of the live project's PostgREST settings the same day listed a legacy JWT secret among them; whether the live project still accepts tokens signed with it is not known.

Until the owner has looked at these, a finding that turns on one of them describes this stack, not the live server. The owner's two answers on the extensions and the signing keys go here when they are known.

## Rules

- Scan `https://127.0.0.1:54321` and nothing else. A site or dashboard built to be scanned points at this address, never at the live project.
- Never copy anything from the stack's folder into the repository. The keys there are made at random on this machine and work nowhere else, but nothing committed may look like a credential.
- Keep the names in `seed.mjs` made up, and never model a sample on anything of a real mine.
- A problem found in the server is fixed in the server, with a migration and a test, not here.
