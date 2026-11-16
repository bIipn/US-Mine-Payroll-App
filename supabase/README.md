# MineMuster database

This is step 1 of MineMuster, the version of the crew app that more than one company can use. It is the shared database underneath: the companies, the people on each company's roster, how a person's account joins their company, and who may see and change what. It is written for a Supabase project (PostgreSQL with Supabase Auth and its API).

Nothing here is connected to the app yet, and nothing here has been applied to a Supabase project. Everything is tested on a local database on this machine.

- `migrations/` holds the SQL migrations, applied in order of their file names.
- `tests/` holds the tests, which run the migrations on a fresh local PostgreSQL ([PGlite](https://pglite.dev)) and try every rule as the API roles would.

The names in the tests and on this page are made up. The repository is public: keep it that way.

## The tables

All four tables are in schema `public`. Row level security is on for every one of them.

### companies

One row for each company that uses the app: a mine, a plant or a contractor.

| Column | What it is |
|---|---|
| `name` | The company's name, 1 to 120 characters once trimmed. Runs of spaces are closed up. |
| `join_code` | The code a new person types to find the company. Unique. See [Join codes](#join-codes). |
| `state` | The two-letter postal code of the state whose hours rules the company follows: one of the 50 states or `DC`. |
| `timezone` | The IANA time zone its days and pay periods are counted in, such as `America/Los_Angeles` (the default). It must be one the database knows. |
| `logo_path` | Where the company's logo is kept in storage. Optional: null means no logo. |
| `pay_period` | The company's pay period rule, as a JSON object. Null means none is set. The shape of the object is the app's to define. |
| `created_by` | The account that started the company. Cleared if that account is deleted. |
| `created_at`, `updated_at` | When it was made and last changed. `updated_at` is kept by the database. |

### roster

Everyone who works for a company, written the way the company writes their name. A supervisor puts people on it. A person's account claims their row when they join, and from then on that row is them in that company.

| Column | What it is |
|---|---|
| `company_id` | The company. A row never moves to another company. |
| `first_name`, `last_name` | The name as the company writes it, which can carry a middle initial, a nickname in quotes or a suffix: `Riley J` `Quinn`, `Lee "Buck"` `Vance III`. |
| `title` | Job title. Optional. |
| `role` | `employee` (the default) or `supervisor`. |
| `active` | False once the person is taken off the roster. An inactive row is never matched to a typed name, and its account is no longer a member. |
| `user_id`, `claimed_at` | The account that claimed the row, and when. Only the functions write these. |

A row is claimed by one account at a time, and a claimed row is never handed straight to another account: a supervisor releases it first (`release_roster_claim`). Deleting an account lets go of its rows. One account holds at most one row in a company, active or not, and may belong to several companies.

### join_requests

When someone with the company's code types a name that is not on the roster, or a name whose row another account has already claimed, the database leaves a request for the company's supervisors. A supervisor approves it or denies it.

| Column | What it is |
|---|---|
| `company_id`, `user_id` | The company, and the account asking to join. |
| `first_name`, `last_name` | The name as the person typed it, trimmed. |
| `reason` | `not_on_roster` (no row fits the name) or `already_claimed` (the row it fits belongs to another account). |
| `status` | `pending`, then `approved` or `denied`. |
| `roster_id` | The row the request was approved onto. |
| `decided_by`, `decided_at` | The supervisor who decided, and when. |

An account has at most one pending request per company. After a denial the person may ask again, which makes a new request.

### notifications

What a company's supervisors are told: `joined` when someone joins by claiming their row (`roster_id` says which), and `join_request` when a new request is left (`request_id` says which). Every supervisor of the company sees the same notifications, and `read_at` is shared: when one supervisor marks a notification read, it is read for all of them. Approving or denying a request writes none: the request already has its own. A notification goes when the row or request it points at is deleted.

## Join codes

- A code is eight characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`: capitals and digits without the look-alikes 0, O, 1 and I. That is 32 characters, so there are about 1.1 trillion codes.
- The database makes them. The randomness comes from `gen_random_uuid()`, which draws on the server's cryptographically strong random source. Each character takes one wholly random byte of a fresh UUID. Since 256 is a multiple of 32, no character is likelier than another. A code already in use is drawn again.
- Codes are read the forgiving way: capitals or not, with spaces or dashes anywhere (`abcd-2345`, `ABCD 2345`). En and em dashes count as dashes, because phones turn a typed hyphen into one.
- A supervisor can give the company a new code with `rotate_join_code`. The old code stops working at once. Everyone who already joined stays on the roster.

## How someone joins

1. **A supervisor starts the company.** They sign in and call `create_company` with the company's name, state and time zone and their own name and title. The database makes the company, puts them on its roster as a supervisor with their account on the row, and hands back the company's id and join code.
2. **The supervisor puts the crew on the roster** and shares the join code with them.
3. **A person signs up and types the code.** The app can call `company_by_code` before they have an account, to show "Join Test Pit A (CA)?". It gives the company's name and state and nothing else.
4. **They type their name.** The app calls `join_company` with the code and the name. It answers with one of these:

| Status | What happened | What the app does |
|---|---|---|
| `no_company` | No company has that code. Nothing is recorded. | Ask them to check the code. |
| `already_member` | Their account already holds an active row there. `role` says which. | Open the company. |
| `joined` | The name is exactly one active row nobody has claimed. It is now theirs, `role` says which, and the supervisors get a `joined` notification. | Open the company. |
| `ambiguous` | The name fits several rows and none exactly. Nothing is recorded. | Ask for the name the way it is on the roster. |
| `pending` | A request is waiting for a supervisor. `reason` is `not_on_roster` or `already_claimed`, and the supervisors get a `join_request` notification. Trying again while it waits returns the same request and adds nothing. | Tell them a supervisor will let them in. |

Every answer but `no_company` carries `company_name`.

5. **A supervisor decides the request.** `approve_join_request` either puts the person on a row already on the roster (`roster_id`, which must be active and unclaimed) or makes a new row from the name on the request, with the given `role` and `title`. `deny_join_request` closes it. A request is decided once.
6. **When the wrong account has a row** (someone typed a coworker's name), a supervisor calls `release_roster_claim` on it. The right person can then join by typing their name, or a supervisor approves their request onto that row.

Claiming locks the row and takes it only while it is still unclaimed, so two people can never claim the same row. The one who comes second gets a `pending` request with reason `already_claimed`. Calls by one account to one company take turns.

A person who was taken off the roster (their row made inactive) and is let back in on a new row lets go of the old one, because an account holds one row per company. To take someone back on their old row instead, a supervisor makes that row active again.

### How a typed name is matched

These are the same rules as `findOnRoster` in `src/domain/roster.ts`. The tests hold the two together: they run every case in its tests, then compare the database with `findOnRoster` itself on more than a thousand typed names.

- A name typed exactly as it is on the roster is that person. Spaces at either end are trimmed, runs of spaces closed up and capitals ignored.
- Otherwise the last names have to agree, give or take a suffix (Jr, Sr, II, III, IV, V), and every word of the typed first name has to be one of the words of the roster's first name. So `Riley` finds `Riley J Quinn`, and `Buck` or `Lee` finds `Lee "Buck" Vance III`. Words are compared in lower case, with quote marks (straight or curly), full stops, commas and hyphens taken out.
- A typed first name made only of single letters, such as `J`, is not a name.
- Only active rows are matched.
- When a name is typed exactly as one row, the rows it only fits do not count: `Lee Park` is Lee Park even with Lee Roy Park on the roster. When it fits several rows and none exactly (`Roy Park` with Lee Roy Park and Roy "Lee" Park), it is ambiguous.

### What the join code does and does not protect

The code is what keeps strangers out: without it, nobody can find a company or ask to join. Anyone who has it can claim an unclaimed row by typing that person's name, so a coworker could take another's row. The supervisors are told of every claim (`joined`) and can release one that is wrong. Rotate the code when it has gone further than the crew.

With the code, typing a name also tells a person whether such a name is on the roster and already claimed. An `ambiguous` answer names nobody.

Guessing a code means searching about 1.1 trillion of them. The database itself does not limit how often codes are tried. If that ever needs tightening, a rate limit in front of `company_by_code` and `join_company` is the place for it.

## Who can do what

| | Read | Change |
|---|---|---|
| **Nobody signed in** (`anon`) | Nothing in any table. | Nothing. Can call `company_by_code` and no other function. |
| **A signed-in account** | Its own join requests. | Can start a company and join one with its code. |
| **An employee** (an active row on the roster) | The company and its whole roster. | Nothing in the tables. |
| **A supervisor** (an active row with the supervisor role) | The company, the roster, the company's join requests and notifications. | The company's name, state, time zone, logo and pay period. Rows on the roster: adding, changing (name, title, role, active) and deleting them. Marking notifications read. Approving and denying requests, rotating the code and releasing claims, through the functions. |
| **The server key** (`service_role`) | Everything. | Everything, as Supabase gives it, and still within the rules below. It is never put in the app. |

Membership is always worked out from the roster: `is_member(company_id)` and `is_supervisor(company_id)` look for the signed-in account on an active row. The row level security policies use them.

These are never written through the API, by anyone, supervisors included: `user_id` and `claimed_at` on the roster, a row's `company_id`, a company's join code, id, creator and dates, and anything in `join_requests` or `notifications` except `read_at`. Column privileges refuse the write outright ("permission denied"), rather than quietly ignoring it.

A member of one company sees and changes nothing of another, in any table or through any function. A function asked about another company's request, row or company gives the same "not found" error as for an id that does not exist.

### A company always keeps a supervisor

Every company keeps at least one active supervisor whose row has an account on it, so someone can always let people in. Whatever would take the last one away is refused, by a trigger on the roster as well as in the functions: a role change, taking the row off the roster, deleting it, releasing its claim, or deleting the supervisor's account. To step down, the last supervisor makes someone else a supervisor first. Deleting the whole company is allowed, and takes its roster, requests and notifications with it.

## The functions

The app calls these through the API (`supabase.rpc('join_company', { code, first_name, last_name })`). Each one is `security definer` with an empty `search_path`, and refuses when nobody is signed in, except `company_by_code`.

| Function | Who | Gives back |
|---|---|---|
| `company_by_code(code)` | anyone | `name` and `state`, or no row |
| `create_company(name, state, timezone, first_name, last_name, title = null)` | signed in | `company_id`, `join_code` |
| `join_company(code, first_name, last_name)` | signed in | `{status, company_name?, role?, reason?}` |
| `approve_join_request(request_id, roster_id = null, role = 'employee', title = null)` | supervisors of the request's company | the roster row's id |
| `deny_join_request(request_id)` | supervisors of the request's company | nothing |
| `rotate_join_code(company_id)` | supervisors of the company | the new code |
| `release_roster_claim(roster_id)` | supervisors of the row's company | nothing |
| `is_member(company_id)`, `is_supervisor(company_id)` | signed in | true or false |

A time zone left empty in `create_company` is `America/Los_Angeles`. With `roster_id`, `approve_join_request` leaves the row's own role and title as they are: `role` and `title` are for a new row.

When a function refuses, the error's code says why:

| Code | Means |
|---|---|
| `42501` | Not signed in, or a write the API does not allow ("permission denied"). |
| `22023` | Something typed is missing or not allowed: a blank name, a state that is not a postal code, an unknown time zone, a role that is not employee or supervisor. |
| `P0002` | Not found, or not the caller's to act on. The two look the same on purpose. |
| `55000` | Not in a state to do that: a request already decided, a row already claimed or taken off, a person already on the roster. |
| `23514` | It would leave the company without an active supervisor. (Also a check constraint, such as a state that is not one of the 51.) |

## Running the tests

They need Node 22 or newer, and nothing else: no Supabase account, no Docker, no network once installed.

```bash
cd supabase/tests
npm install
npm test
```

`npm test` runs `node --test *.db.mjs`. Each test file starts a fresh PGlite database. It first makes stand-ins for what every Supabase project already has (`tests/supabase-stub.mjs`): the `auth` schema with `auth.users` and `auth.uid()`, the roles `anon`, `authenticated` and `service_role`, and Supabase's default grants on schema `public`. It then applies every migration in order and makes its requests the way the API does, as the role `anon` or `authenticated` with the account's id in `request.jwt.claim.sub`. Every test makes its own companies and accounts, so none depends on another.

There are 125 tests, in about 15 seconds:

| File | What it holds to |
|---|---|
| `companies.db.mjs` | Starting a company, the join code and its alphabet, rotating it, company settings |
| `join.db.mjs` | Every `join_company` status, reading codes, claiming a row only once |
| `requests.db.mjs` | Approving onto a row or a new one, denying, deciding once, supervisors only |
| `isolation.db.mjs` | A member of one company sees and changes nothing of another, and the errors say nothing about it |
| `employee.db.mjs` | What an employee cannot do, and what nobody writes through the API |
| `supervisor-guard.db.mjs` | The last supervisor, on every path |
| `anon.db.mjs` | `anon` calls `company_by_code` and nothing else, and reads nothing |
| `names.db.mjs` | Name matching, against `findOnRoster` itself |
| `notifications.db.mjs` | One for each join and new request, seen by that company's supervisors only |
| `security.db.mjs` | Empty `search_path`, EXECUTE grants, row level security, each role's privileges, and that the migrations leave Supabase's own schema and roles alone |

`names.db.mjs` loads `src/domain/roster.ts` directly (Node strips its types), and Node prints one warning about the module type when it does. That warning is expected. If the file ever cannot be loaded, that one test is skipped and says why.

The tests run on PGlite's PostgreSQL 18. They pass on its builds of PostgreSQL 17 and 16 as well. One local database is one session, so two people joining at the same instant cannot be acted out here. The row lock in `join_company`, the trigger that refuses to hand a claimed row to another account and the one-row-per-account index are what settle that case, and the last two are tested.

The app's own `npm test` (Jest) does not pick these files up, because they are named `*.db.mjs`. The app's `npm run typecheck` reads them as plain JavaScript but does not check them.

## Applying the migrations to a Supabase project

Not done yet, and not to be done from a test. When the project exists:

1. Apply the files in `migrations/`, in order, once each, to a project on PostgreSQL 15 or newer. New Supabase projects are; `select version();` in the SQL editor shows what an older one runs. The migrations expect what Supabase already provides (the `auth` schema, `auth.users`, `auth.uid()` and the roles), and they neither create nor change any of it. Do not apply anything from `tests/`.
   - With the [Supabase CLI](https://supabase.com/docs/guides/cli), from the repository root: `supabase link --project-ref <project-ref>`, then `supabase db push`. The CLI records which migrations have run, so a later `supabase db push` applies only new ones; `supabase migration list` shows where things stand. (`supabase init` first if the CLI asks for a `supabase/config.toml`.)
   - To try them on Supabase's local stack first: `supabase start`, then `supabase db reset`.
   - Without the CLI: paste each file into the dashboard's SQL editor, in order.
2. Run the dashboard's Security Advisor. It may point out that the functions above are `security definer` and callable by signed-in users, and `company_by_code` by `anon`. That is on purpose: each one checks who is calling, and nothing else is callable.
3. Turn on the sign-in providers in Supabase Auth. The database needs nothing more: it reads the account from `auth.uid()`.

### Adding to it later

- One new file in `migrations/` per change, named `YYYYMMDDHHMMSS_what_it_does.sql`. Never edit a migration that has been applied; write a new one.
- Lock a new table in the file that makes it: `enable row level security` and `revoke all ... from public, anon, authenticated`. Grant and add policies in the same migration, or in the next one.
- Every new function gets `set search_path = ''`, fully qualified names, `revoke all on function ... from public, anon, authenticated, service_role`, and a grant to the roles that call it. Supabase grants EXECUTE on every new function in `public` to everyone unless the migration takes it back.
- PostgreSQL checks EXECUTE against the role doing the write, even for a function called from a check constraint or inside a trigger. So constraints use built-in functions only, and a trigger that calls a private helper is `security definer`.
- Keep the files plain ASCII: write a character such as a no-break space as a regular-expression escape (`\x00a0`). A test checks this.
- Add a test beside the others, and keep the names in it made up.
