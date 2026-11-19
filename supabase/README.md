# MineMuster database

This is step 1 of MineMuster, the version of the crew app that more than one company can use. It is the shared database underneath: the companies, the people on each company's roster, how a person's account joins their company, and who may see and change what. It is written for a Supabase project (PostgreSQL with Supabase Auth and its API). Step 2 adds the records the crew's phones send: see [The records](#the-records). Step 3 adds what a company pays through Stripe and the contact form on minemuster.com: see [Billing](#billing) and [The contact form](#the-contact-form).

The app and the office dashboard (https://app.minemuster.com) connect to the MineMuster Supabase project, where these migrations are being applied in order: check which have run (`supabase migration list`, or the project's migrations page) before counting on one. Everything here is tested on a local database on this machine, and the rules that only show when two requests overlap on a throwaway local PostgreSQL server.

- `migrations/` holds the SQL migrations, applied in order of their file names.
- `functions/` holds the edge functions: `stripe-webhook`, where Stripe sends its events (see [The webhook](#the-webhook)).
- `tests/` holds the tests, which run the migrations on a fresh local PostgreSQL ([PGlite](https://pglite.dev)) and try every rule as the API roles would.
- `tools/` holds `make_name_skeleton_table.py`, which makes the table of look-alike characters in `20261116002500_lookalike_names.sql` from Unicode's `confusables.txt` (see [How a typed name is matched](#how-a-typed-name-is-matched)).

The names in the tests and on this page are made up. The repository is public: keep it that way.

## The tables

The four tables below are in schema `public`, and row level security is on for every one of them. Two more there hold what the functions keep for themselves, and neither `anon` nor `authenticated` may read or write them: `company_supervisor_guard`, the row the last-supervisor guard writes for each company whose supervisors change (see [A company always keeps a supervisor](#a-company-always-keeps-a-supervisor)), and `join_holds`, the accounts a supervisor has acted on in a company (released, barred, or both, one row for each; see [How someone joins](#how-someone-joins)). The records the phones send are in two more, `records` and `record_history`, and `push_records` keeps its own counts in `record_counters` and `record_usage` (see [The records](#the-records)). Billing is in `billing_subscriptions`, `billing_overrides` and `stripe_events` (see [Billing](#billing)), and the website's contact form in `contact_requests`, with `contact_senders` and `contact_sender_key` for its limit on each sender (see [The contact form](#the-contact-form)). None of the sixteen keeps planner statistics (see [What a count can tell](#what-a-count-can-tell)).

### companies

One row for each company that uses the app: a mine, a plant or a contractor.

| Column | What it is |
|---|---|
| `name` | The company's name, 1 to 120 characters once trimmed. Runs of spaces are closed up. |
| `join_code` | The code a new person types to find the company. Unique. See [Join codes](#join-codes). |
| `state` | The two-letter postal code of the state whose hours rules the company follows: one of the 50 states or `DC`. |
| `timezone` | The IANA time zone its days and pay periods are counted in, such as `America/Los_Angeles` (the default). It must be one the database knows. |
| `logo_path` | Where the company's logo is kept in storage. Optional: null means no logo. A file in the company's own storage: no `..` segment, no leading `/`, no backslash and no hidden characters. Storage should still build the full path from the company's id. |
| `pay_period` | The company's pay period rule, as a JSON object of at most 16 KiB as text. Null means none is set. The shape of the object is the app's to define. |
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

A row is claimed by one account at a time, and a claimed row is never handed straight to another account: a supervisor releases it first (`release_roster_claim`), or approves the right person's request onto it with `replace_claim`, which does both in one step. Deleting an account lets go of its rows. One account holds at most one row in a company, active or not, and may belong to several companies.

### join_requests

When someone with the company's code types a name that is not on the roster, or a name whose row another account has already claimed, the database leaves a request for the company's supervisors. A supervisor approves it or denies it.

| Column | What it is |
|---|---|
| `company_id`, `user_id` | The company, and the account asking to join. |
| `first_name`, `last_name` | The name as the person typed it, trimmed. |
| `reason` | Why the name did not join by itself: `not_on_roster` (no row fits the name), `already_claimed` (the one row it fits is another account's), `supervisor_row` (the one row it fits has the supervisor role, never handed out by a typed name), `removed` (the caller was taken off this roster), `released` (a supervisor released the caller's claim here, or deleted the caller's row), or `ambiguous` (the name is written the same way for several people, so no typing can single one out). |
| `status` | `pending`, then `approved` or `denied` by a supervisor, or `withdrawn` when the account joined by itself or was taken back on its old row while the request waited. A withdrawn request is kept, with its notification, and is decided: it can be neither approved nor denied. |
| `roster_id` | The row the request was approved onto. |
| `decided_by`, `decided_at` | The supervisor who decided, and when. |

An account has at most one pending request per company. After a denial the person may ask again, which makes a new request, unless the supervisor denied it with a bar.

### notifications

What a company's supervisors are told: `joined` when someone joins by claiming their row (`roster_id` says which), and `join_request` when a new request is left (`request_id` says which). Every supervisor of the company sees the same notifications, and `read_at` is shared: when one supervisor marks a notification read, it is read for all of them. Approving or denying a request writes none: the request already has its own. A request that is withdrawn keeps its notification, so the supervisors still see, for instance, that an account first typed a claimed coworker's name and then an unclaimed one. A notification goes when the row or request it points at is deleted.

## Join codes

- A code is eight characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`: capitals and digits without the look-alikes 0, O, 1 and I. That is 32 characters, so there are about 1.1 trillion codes.
- The database makes them. The randomness comes from `gen_random_uuid()`, which draws on the server's cryptographically strong random source. Each character takes one wholly random byte of a fresh UUID. Since 256 is a multiple of 32, no character is likelier than another. A code already in use is drawn again.
- Codes are read the forgiving way: capitals or not, with spaces or dashes anywhere (`abcd-2345`, `ABCD 2345`). En and em dashes count as dashes, because phones turn a typed hyphen into one.
- A supervisor can give the company a new code with `rotate_join_code`. The old code stops working at once. Everyone who already joined stays on the roster.

## How someone joins

1. **A supervisor starts the company.** They sign in and call `create_company` with the company's name, state and time zone and their own name and title. The database makes the company, puts them on its roster as a supervisor with their account on the row, and hands back the company's id and join code. One account starts at most 3 companies in any 24 hours and 20 in all (migration `20261117000800`, below).
2. **The supervisor puts the crew on the roster** and shares the join code with them.
3. **A person signs up and types the code.** The app can call `company_by_code` before they have an account, to show "Join Test Pit A (CA)?". It gives the company's name and state and nothing else.
4. **They type their name.** The app calls `join_company` with the code and the name. It answers with one of these:

| Status | What happened | What the app does |
|---|---|---|
| `no_company` | No company has that code. Nothing is recorded. | Ask them to check the code. |
| `already_member` | Their account already holds an active row there. `role` says which. | Open the company. |
| `denied` | A supervisor denied this account with a bar. Nothing is recorded, and no notification is sent. | Tell them a supervisor has turned the request down, and to speak to one. |
| (refused, `22023`) | The name only looks like a name on the roster: no row of the company is it or fits it, but one does once both are read for the characters they look like (see [How a typed name is matched](#how-a-typed-name-is-matched)). Nothing is recorded. | Ask for the name the way it is written on the roster. |
| `joined` | The name is exactly one active, unclaimed **employee** row. It is now theirs, `role` says which, and the supervisors get a `joined` notification. Any request of theirs still pending there is settled as `withdrawn`. A supervisor row is never claimed this way; it becomes a `pending` request instead, and so does any name typed by an account that was taken off the roster or whose claim was released. | Open the company. |
| `ambiguous` | The name only loosely fits several rows and none exactly, so typing the whole name as it is on the roster would settle it. Nothing is recorded. | Ask for the name the way it is on the roster. |
| `pending` | A request is waiting for a supervisor. `reason` is `not_on_roster`, `already_claimed`, `supervisor_row` (the row it fits is a supervisor row), `removed` (the caller was taken off this roster), `released` (a supervisor released the caller's claim, or deleted the caller's row), or `ambiguous` (the name is written the same for several people). The supervisors get a `join_request` notification. Trying again while it waits returns the same request and adds nothing. | Tell them a supervisor will let them in. |

Every answer but `no_company` carries `company_name`.

5. **A supervisor decides the request.** `approve_join_request` either puts the person on a row already on the roster (`roster_id`, which must be active and unclaimed, unless `replace_claim` is given; see step 6) or makes a new row from the name on the request, with the given `role` and `title`. `deny_join_request` closes it; with `bar`, it also turns the account away from the company from then on (`join_company` answers `denied` and records nothing) until a supervisor calls `lift_join_bar` with any of that account's requests. A bar holds in that company only, and is kept apart from a release (step 6): lifting the bar leaves an account whose claim was released still held, so it may ask again but still takes no row by typing a name. A request is decided once.
6. **When the wrong account has a row** (someone typed a coworker's name), the simplest fix is one step: approve the right person's request onto that row with `replace_claim`, which lets go of the wrong account and gives the row to the right one in the same transaction, so nobody with the code can take it in between. A supervisor can also call `release_roster_claim` on the row; the right person can then join by typing their name if it is an employee row, or a supervisor approves their request onto it. Either way the account the row was taken from is held: it can no longer take any row by typing a name, and typing one leaves a `released` request. The same goes for an account whose row a supervisor deletes. Approving one of its requests lets it in and lifts the hold. A released **supervisor** row is never re-claimed by a typed name either: typing it leaves a request to approve.

Claiming locks the row and takes it only while it is still unclaimed, so two people can never claim the same row. The one who comes second gets a `pending` request with reason `already_claimed`. Once the row is locked the name is matched again, so a row a supervisor renames while its old name is being typed is not handed out under a name nobody typed. Calls by one account to one company take turns, with each other and with a supervisor approving or denying that account's request, so someone who types a name while their request is being approved is told `already_member`. They also take turns with a supervisor's change to the caller's own row in that company (releasing it, deleting it, handing it to someone else, taking the person back): `join_company` locks that row before it reads anything about the caller, so it sees such a change whole, never half of it.

A person who was taken off the roster (their row made inactive) is not let back in by themselves: typing their name — or anyone's — leaves a `removed` request, so a supervisor decides. Releasing or deleting their old row does not change that: they are held, and their requests say `released`. Approving it puts them on the given row (or a new one) and lets go of their old inactive row, because an account holds one row per company. To take someone back on their old row instead, a supervisor makes that row active again; the request they left while they were off is then settled as `withdrawn`, so it cannot be approved after a later removal.

### How a typed name is matched

These are the same rules as `findOnRoster` in `src/domain/roster.ts`. The tests hold the two together: they run every case in its tests, then compare the database with `findOnRoster` itself on more than a thousand typed names, and on Greek names typed in capitals. Outside that, the app still has to catch up with three things the database does: compose a name (`normalize('NFC')` in `cleanText`), fold a capital I with a dot (U+0130) to I before `toLowerCase` and a final sigma to a medial one after it, and count a word's length in code points (`[...word].length`) for the rule on initials. A test marked `todo` in `names.db.mjs` shows where the two still differ until `roster.ts` does the same.

- A name typed exactly as it is on the roster is that person. It is composed first (Unicode NFC, so an accent typed as a separate mark is the same letter), spaces at either end are trimmed, runs of spaces closed up and capitals ignored. A capital I with a dot counts as I, and a final sigma as the sigma it is.
- Otherwise the last names have to agree, give or take a suffix (Jr, Sr, II, III, IV, V), and every word of the typed first name has to be one of the words of the roster's first name. So `Riley` finds `Riley J Quinn`, and `Buck` or `Lee` finds `Lee "Buck" Vance III`. Words are compared in lower case, with quote marks (straight or curly), full stops, commas and hyphens taken out.
- A typed first name made only of single letters, such as `J`, is not a name.
- Only active rows are matched and claimed. The server looks for the exact match over every row of the company first, active or not, and runs the looser fallback only when no row is the name exactly and no *inactive* row fits it either: so typing a removed person's name, exactly or the looser way (`Riley J.` for `Riley J`, a suffix left off), never stands in for a different, still-active person, and leaves a request instead. (The app only ever matches active rows; this is a server-side guard the app cannot reach.)
- When a name is typed exactly as one row, the rows it only fits do not count: `Lee Park` is Lee Park even with Lee Roy Park on the roster. When it fits several rows and none exactly (`Roy Park` with Lee Roy Park and Roy "Lee" Park), it is ambiguous. When several rows are written the *same* way, so no typing can single one out, `join_company` leaves an `ambiguous` request for a supervisor instead of recording nothing.
- A name may not hold a control character or an invisible one: any of Unicode's default-ignorable characters (a zero-width space, a bidi override, a soft hyphen, a variation selector, a tag character, a Hangul filler, ...) or another format character. Nor may a name, first and last together, mix letters of the Latin, Greek and Cyrillic alphabets, which have look-alikes of each other; a name wholly in one of them is fine. Such a name is refused (`22023`), so a request cannot pose as a claimed coworker's name with a hidden or look-alike character in it. These rules hold for typed names, roster names and titles (and hidden characters for company names), and are checked when a name is written, so a rule made stricter later never blocks other changes to an older row.
- A name that only *looks* like a name on the roster is refused too (`22023`), whatever alphabets it is written in: `Joe Cox` written wholly in Cyrillic look-alikes, a small capital O or a Roman numeral fifty among Latin letters, a mathematical or fullwidth letter, a capital I for a small l, `rn` for `m`, an Armenian or Cherokee look-alike. Names are compared by what they look like (`name_skeleton`, after Unicode's confusables, UTS #39): compatibility forms folded (NFKC), every character Unicode lists as looking like a Latin letter, a quote mark, an apostrophe, a hyphen, a full stop or a comma read as it, `rn` read as `m`, and then capitals ignored, keeping a capital L apart from the small l that I, 1 and | look like (so `Lan` is not `Ian`). `join_company` refuses a typed name that no row of the company, active or not, is or fits, but that one is or fits once both are read that way; nothing is recorded. The roster refuses a name, when it is written, that looks the same as another row of the company without being written the same, so approving such a request cannot put a second row on the roster that reads the same. Two rows written exactly the same stay allowed. Two different people whose names only look alike (`Arnie` and `Amie`, say) are told apart on the roster some other way, such as a middle initial. The table of look-alike characters is made from Unicode's `confusables.txt` by `tools/make_name_skeleton_table.py` (`python3 -I tools/make_name_skeleton_table.py confusables.txt`) and is never edited by hand: a new table goes into a new migration that replaces `name_skeleton`. A look-alike Unicode does not list remains possible, so the app should still show a supervisor each request's `reason`.

### What the join code does and does not protect

The code is what keeps strangers out: without it, nobody can find a company or ask to join. Anyone who has it can claim an unclaimed **employee** row by typing that person's name, so a coworker could take another's row. The supervisors are told of every claim (`joined`) and can release one that is wrong. Rotate the code when it has gone further than the crew.

A **supervisor** row is never handed out by a typed name, whatever code the caller has: a match onto one leaves a `supervisor_row` request for an existing supervisor to approve. So the code alone makes nobody a supervisor, and the company cannot be taken over by claiming an unclaimed supervisor row. A person taken off the roster leaves a `removed` request rather than walking back in, and an account whose claim was released a `released` one. A supervisor can keep one account out, short of rotating the code, by denying it with a bar. A **Supabase anonymous sign-in** (a throwaway account) is refused by `join_company` and `create_company`, so anonymous sessions cannot claim rows or flood requests if the project turns anonymous sign-ins on.

With the code, typing a name also tells a person whether such a name is on the roster and already claimed. An `ambiguous` answer names nobody.

Guessing a code means searching a space of about 1.1 trillion (32^8). Every company shares that one space, so a single guess finds *some* company with probability N/32^8 for N companies, not 1/32^8: a stranger looking for any company at all needs on the order of 1.1 trillion / N guesses, fewer as more companies sign up. The database itself does not limit how often codes are tried. That limit belongs in front of `company_by_code` and `join_company` — a rate limit or an Edge Function — and should be added before launch.

## Who can do what

| | Read | Change |
|---|---|---|
| **Nobody signed in** (`anon`) | Nothing in any table. | Nothing. Can call `company_by_code` and `submit_contact_request` (the website's contact form) and no other function. |
| **A signed-in account** | Its own join requests, through `my_join_requests()` (the `join_requests` table itself is readable only by a company's supervisors, and the function never returns `decided_by` or `roster_id`). The companies it belongs to, through `my_companies()`. | Can start a company and join one with its code, unless it is an anonymous sign-in. |
| **An employee** (an active row on the roster) | The company and its whole roster. The records the crew works from, and the shifts and denied punches its own account sent first as an employee (see [Reading records](#reading-records)). | Nothing in the tables. Sends records through `push_records`, as far as [who writes what](#sending-records-push_records) allows. |
| **A supervisor** (an active row with the supervisor role) | The company, the roster, the company's join requests and notifications. Every record of the company and every version of each, while the company has MineMuster (see [What a supervisor reads](#what-a-supervisor-reads)). The company's billing: its rows in `billing_subscriptions` and `billing_overrides`, and `company_billing`. | The company's name, state, time zone, logo and pay period. Rows on the roster: adding, changing (name, title, role, active) and deleting them. Marking notifications read. Approving and denying requests (with or without a bar), lifting a bar, rotating the code and releasing claims, through the functions. Every kind of record, through `push_records`. |
| **The server key** (`service_role`) | Everything. | Everything, as Supabase gives it, and still within the rules below, including the last-supervisor guard. `TRUNCATE` on the six tables of step 1 is taken away from it, so the key cannot empty a table past the triggers. `records`, `record_history`, `record_counters` and `record_usage` it reads and never writes: only `push_records` does. `billing_subscriptions`, `billing_overrides` and `contact_requests` it reads and never writes, and `stripe_events`, `contact_senders` and `contact_sender_key` it neither reads nor writes. It alone can call `is_last_supervisor`, `step_down_everywhere`, `apply_stripe_event` and `stripe_webhook_secret`. It is never put in the app; the webhook holds it. |

Membership is always worked out from the roster: `is_member(company_id)` and `is_supervisor(company_id)` look for the signed-in account on an active row, and only while Supabase Auth has neither soft-deleted the account (`deleted_at`) nor banned it (`banned_until` still to come), the same test the last-supervisor guard counts by. So an account that is banned or soft-deleted loses every power at once, in every company, even though an access token it already holds stays valid until it expires: it reads nothing, changes nothing and calls no supervisor function, and `join_company` and `create_company` refuse it (`42501`). The row level security policies compare each row's company with the caller's own companies (`member_company_ids()` and `supervisor_company_ids()`, by the same rule), worked out once per statement. Each of these functions reads the caller's id once per call, as `(select auth.uid())` (migration `20261117000700`), not once for each roster row it reads.

These are never written through the API, by anyone, supervisors included: `user_id` and `claimed_at` on the roster, a row's `company_id`, a company's join code, id, creator and dates, anything in `join_requests` or `notifications` except `read_at`, and anything in `company_supervisor_guard`, `join_holds`, `records`, `record_history`, `record_counters`, `record_usage`, `billing_subscriptions`, `billing_overrides`, `stripe_events`, `contact_requests`, `contact_senders` or `contact_sender_key`. Column privileges refuse the write outright ("permission denied"), rather than quietly ignoring it.

A member of one company sees and changes nothing of another, in any table or through any function. A function asked about another company's request, row or company gives the same "not found" error as for an id that does not exist.

### What a count can tell

Row level security hides rows, not the planner's statistics, and PostgREST answers a request made with `Prefer: count=planned` (supabase-js: `select(..., { count: 'planned' })`) with the planner's row estimate for the caller's own query. With ordinary statistics that estimate is worked out from every company's rows: it would tell a real company id from a made-up one and roughly how many people it has, confirm that a surname is on another company's roster, and give up other companies' ids to anyone who bisects `company_id < X`. So no column of any table here keeps statistics (`set statistics 0`, migration `20261116002200`, and `20261117000100` for the records), and every estimate is the planner's fixed default. What an estimate still reflects is a table's total number of rows across all companies, never one company's. Statistics already gathered survive turning them off, which is why this lands with the tables, before they hold data.

Nor does how long a request takes depend on another company's rows. A policy that called a function on each row it met (`is_member(company_id)`) read every company's rows for a request with no filter of its own, and took longer the more hidden rows fit the caller's filter: response times told a real company id from a made-up one and roughly how many people it has, confirmed a surname on another company's roster, and gave up the leading digits of other companies' ids to anyone who bisected `company_id < X`. Each policy is now a comparison of the row's company with the caller's own companies, worked out once per statement (`company_id = any ((select public.member_company_ids())::uuid[])`, migration `20261116002300`). PostgreSQL uses it as an index condition, so rows of other companies are not read at all (`row_reads.db.mjs` checks the plans and the times). What remains is small: a filter on another indexed column, such as `companies?created_by=eq.<account>`, can make the scan fetch the few rows that match it and drop them by that plain comparison, a matter of microseconds rather than a function call and a roster lookup for each.

PostgREST can also be set to hand back the plan of any request (its `db-plan-enabled` setting, off unless turned on). Keep it off in production: with it, `Rows Removed by Filter` in a plan counts rows the caller cannot see, such as another account's companies through that `created_by` index.

### A company always keeps a supervisor

Every company keeps at least one active supervisor whose account can still sign in, so someone can always let people in. An account counts while it is on the row and Supabase Auth has neither soft-deleted it (`deleted_at`) nor banned it (`banned_until` still to come). Whatever would take the last one away is refused, by a trigger on the roster as well as in the functions: a role change, taking the row off the roster, deleting it, releasing its claim, handing it to someone else, or deleting the supervisor's account. To step down, the last supervisor makes someone else a supervisor first. Deleting the whole company is allowed, and takes its roster, requests, notifications and holds with it.

A soft delete or a ban is a change to Supabase's own `auth.users`, which these migrations never put a trigger on, so the database cannot refuse it. And it is a Supabase Auth call, outside the database's transaction, so checking `is_last_supervisor(user_id)` and then banning does not hold when two such requests overlap: each check sees the other supervisor still there, and both bans go through. **The server steps an account down first, with `step_down_everywhere(user_id)`, and bans or soft-deletes it only once that has returned.** It makes the account an employee on every active supervisor row it holds, in one statement, so the guard refuses it (`23514`, nothing changed anywhere) while the account is the last supervisor who can sign in in any company; two at once for the supervisors of one company take turns, and the second is refused. `is_last_supervisor` stays, to show which accounts are the last supervisor somewhere. A hard delete (`auth.admin.deleteUser(id)`) is refused by the guard already. Once an account is soft-deleted or banned it stops counting, so the other supervisors cannot step down past it, and it has no supervisor power left (see [Who can do what](#who-can-do-what)).

The guard holds even when two changes overlap. Before it counts, it writes a row (`company_supervisor_guard`) for each company that lost a counting supervisor in the statement, in a fixed order so two statements cannot deadlock. So two transactions that each remove a different supervisor of the same company — two supervisors stepping down at once, releasing each other, or one supervisor sending two requests — cannot both go through. At READ COMMITTED (PostgREST's default) the second waits, then sees the first's committed change and is refused (`23514`). At REPEATABLE READ or SERIALIZABLE, as a direct connection or a function may run, the second is told to try again (`40001`); when it does, it sees the first's change. A lock alone would not do at those levels: it makes no new row version, so the second would count with its older snapshot and both could commit, leaving the company with none.

## The functions

The app calls these through the API (`supabase.rpc('join_company', { code, first_name, last_name })`). Each one is `security definer` and searches `pg_catalog` first and the temporary schema last (`search_path = pg_catalog, pg_temp`), and refuses when nobody is signed in — and, for `join_company` and `create_company`, when the sign-in is anonymous or the account can no longer sign in — except `company_by_code` and `submit_contact_request`, which anyone may call, and `is_member`, `is_supervisor`, `member_company_ids` and `supervisor_company_ids`, which answer false (or no companies) when nobody is signed in because the row level security policies call them and must never raise. `is_last_supervisor`, `step_down_everywhere`, `apply_stripe_event` and `stripe_webhook_secret` are for the server key only.

| Function | Who | Gives back |
|---|---|---|
| `company_by_code(code)` | anyone | `name` and `state`, or no row |
| `create_company(name, state, timezone, first_name, last_name, title = null)` | signed in | `company_id`, `join_code` |
| `join_company(code, first_name, last_name)` | signed in | `{status, company_name?, role?, reason?}` |
| `approve_join_request(request_id, roster_id = null, role = 'employee', title = null, replace_claim = false)` | supervisors of the request's company | the roster row's id |
| `deny_join_request(request_id, bar = false)` | supervisors of the request's company | nothing |
| `lift_join_bar(request_id)` | supervisors of the request's company | nothing; the account that made the request may ask again |
| `rotate_join_code(company_id)` | supervisors of the company | the new code |
| `release_roster_claim(roster_id)` | supervisors of the row's company | nothing |
| `my_join_requests()` | signed in | the caller's own join requests, without `decided_by` or `roster_id` |
| `push_records(company_id, changes)` | members of the company | `{accepted, ignored, deferred?}`; see [Sending records](#sending-records-push_records) |
| `my_companies()` | signed in | the companies the caller belongs to: `id`, `name`, `state`, the caller's `role`, and `join_code` where they are a supervisor |
| `is_member(company_id)`, `is_supervisor(company_id)` | signed in | true or false |
| `member_company_ids()`, `supervisor_company_ids()` | signed in (the policies call them) | the ids of the caller's own companies, and of those it supervises |
| `records_open_company_ids()` | signed in (the policies call it) | the ids of the caller's companies whose records it reads: all of them, but one it supervises only while that company has MineMuster |
| `is_last_supervisor(user_id)` | the server key | true when that account is, in some company, the only active supervisor who can still sign in |
| `step_down_everywhere(user_id)` | the server key | how many supervisor rows it made employee rows; refused (`23514`) while the account is the last supervisor who can sign in somewhere |
| `company_billing(p_company_id)` | supervisors of the company | `{access, status, trial_end, current_period_end, cancel_at_period_end, running, had_trial}`; see [Where a company stands](#where-a-company-stands) |
| `apply_stripe_event(p_event)` | the server key (the webhook) | `{applied: true, ...}` or `{applied: false, reason}`; see [Stripe's events](#stripes-events) |
| `stripe_webhook_secret()` | the server key (the webhook) | the webhook's signing secret from Vault, or null |
| `submit_contact_request(p_name, p_company, p_email, p_phone, p_message, p_website)` | anyone | `{ok: true}`; see [The contact form](#the-contact-form) |

A time zone left empty in `create_company` is `America/Los_Angeles`. One account starts at most 3 companies in any 24 hours and 20 in all, counted from the companies it started (`companies.created_by`, kept by `create_company` and never written through the API); joining a company counts toward neither. Past either, `create_company` raises `PT429` with hint `too_many_today` ("This account has started 3 companies in the last 24 hours. Try again in a day.") or `too_many_in_all` ("This account has started 20 companies, the most one account may. Write to MineMuster to start more."), which is the one given when both apply, since waiting a day does not lift it. A call refused for what was typed counts toward neither. There is no exception per account. When someone past the 20 writes to ask for another company, the owner starts it for them in the SQL editor, as postgres: insert the company with `created_by` set to their account and a join code from `public.new_join_code()`, then their roster row as its supervisor, holding their account (`user_id`, `claimed_at`), exactly as `create_company` does. The limit does not apply there, and `created_by` still records who it is for. One account's calls take turns from the count to the commit, so two at once cannot both slip under a limit (`races.db.mjs`). With `roster_id`, `approve_join_request` leaves the row's own role and title as they are: `role` and `title` are for a new row. With `replace_claim`, a row another account holds is let go of and given to the request's account in one step; that other account is held, as a released claim is.

When a function refuses, the error's code says why:

| Code | Means |
|---|---|
| `42501` | Not signed in, an anonymous sign-in where an account is needed, an account Supabase Auth has banned or soft-deleted, or a write the API does not allow ("permission denied"). |
| `22023` | Something typed is missing or not allowed: a blank name, a name with a control or invisible character or with letters of more than one alphabet, a name that only looks like one on the roster, a state that is not a postal code, an unknown time zone, a role that is not employee or supervisor, a logo path outside the company's own storage, a call to `push_records` whose changes are not a list or number more than 200, a contact form field that is missing or too long, or an `apply_stripe_event` call with something that is not a Stripe event. |
| `PT404` | Not found, or not the caller's to act on. The two look the same on purpose. PostgREST answers it with HTTP 404. (Before migration `20261117000600` this was `P0002`, which PostgREST answers with 500.) |
| `PT409` | Not in a state to do that: a request already decided, a row already claimed or taken off, a person already on the roster. PostgREST answers it with HTTP 409. (`55000` before `20261117000600`, also answered with 500.) |
| `23514` | It would leave the company without an active supervisor. (Also a check constraint, such as a state that is not one of the 51, or a pay period over 16 KiB as text, over 64 KiB as stored, or holding a number no browser sends.) |
| `PT429` | A limit: the contact form's (too many messages from one email address, from one sender, or from everyone in the last hour), or `create_company`'s (3 companies started in any 24 hours, 20 in all, for one account). The hint says which. PostgREST answers it with HTTP 429. |
| `40001` | Two changes to the same company's supervisors overlapped at REPEATABLE READ or SERIALIZABLE. Try again. (PostgREST runs at READ COMMITTED, where the second waits and gets `23514` instead.) Also two `push_records` calls from one company at once, at those levels: the second has to try again. And the one 40001 `push_records` raises itself ("Another phone was sending the same record. Try again."): a record written by something other than `push_records`, as the owner can in the SQL editor, after `push_records` read and before it wrote. PostgREST tries a 40001 again by itself, with no limit; the call made again reads that record and is answered at once, as for any record already there (`record_races.db.mjs`). Nothing an API caller does can make it last: every write to `records` through the API is `push_records`, which takes the company's counter before it reads. |

PostgREST picks the HTTP status from the code: a `PTnnn` code is HTTP nnn, with its message and hint kept in the body; `42501` is 401 without a sign-in and 403 with one; `22023` and `23514` are 400. Every refusal is one of these, never a code PostgREST answers with 500 (`security.db.mjs` reads every raise in every function to check, whatever its shape: `raise sqlstate '...'`, a condition name such as `no_data_found`, the code in any case or spacing, an `assert`, and a handler raising again what it caught, each with the code PostgreSQL itself gives it); the `40001` above is not a refusal. A raise with no code of its own (`P0001`) would be 400 and a duplicate raised again (`23505`) 409. Read the code, not the status: PostgREST also answers 404 for a function that does not exist (`PGRST202`) and 409 for a duplicate (`23505`). A client should still read `P0002` and `55000` as these two, for a server where `20261117000600` has not run yet; the phone and the dashboard do. PostgREST writes a `PTnnn` code's message into the HTTP status line too (`HTTP/1.1 404 No such company.`), so such a message is always a constant on one line, never text from the request: a line break in it would start a header.

## The records

Step 2: what the crew's phones share. Everything a person does in the app is saved on their phone first and sent when the phone can reach the server (`changesToSend` and `sendWaiting` in `src/domain/sync.ts`, through `pushTransport` in `src/services/server.ts`). The server keeps the latest version of each record in `records` and every version it has taken in `record_history`, and takes them only through `push_records`. The migrations are `20261117000100` (the tables), `20261117000200` (who reads them, and `my_companies`), `20261117000300` (`push_records`), `20261117000400` (the pay period's size, checked the same safe way as a record's) and `20261117000900` (who completes a maintenance request).

Phones send and do not pull yet. A phone knows only the versions the server confirmed to it, so it can be behind: it has not seen a supervisor's correction, a coworker's change to a unit, or a deletion. Several of the rules below exist so that such a phone cannot undo what it has not seen.

A record has a kind, one of the eleven the app sends, in the order it sends them: `settings`, `employee`, `equipment`, `areaSheet`, `shift`, `denied`, `leave`, `inspection`, `opLog`, `exam`, `mrf`. Its id is the phone's own id for it; the shared settings are the one record `settings:company`, and hold only `company`, `site`, `workweekStartsOn` and `allowSectionAllOk`. Its rev is the phone's version of it, a hash of the record (20 hex characters from the app), or `deleted` for a record taken off a phone.

### records

| Column | What it is |
|---|---|
| `company_id`, `kind`, `id` | The record: its company, kind and id, which together are its key. The id is 1 to 120 characters with no control character. |
| `rev` | The version last taken, 1 to 64 characters, or `deleted`. |
| `data` | The record as the phone sent it: a JSON object of at most 1 MB as stored and 256 KB as text (see [Size](#size)). `{}` once it is deleted. |
| `deleted` | True once a supervisor has deleted it. The row stays, so a phone that reads it learns it is gone. |
| `version` | How many versions of it the server has taken: its newest `version` in `record_history`. |
| `seq` | The company's number for its latest version. Every version a company's phones send gets the next number, so a client pulls what changed by asking for `seq` greater than the last one it has (see [Pulling what changed](#pulling-what-changed)). |
| `created_by`, `updated_by` | The account that first sent it, and the one that sent its latest version. Cleared if that account is deleted. |
| `created_by_supervisor` | Whether that first account was a supervisor of the company when it sent it. What an account sent as a supervisor stays a supervisor's: made an employee later, the account no longer reads or changes it. |
| `created_at`, `updated_at` | When it was first and last taken, for showing. Not for pulling: every change of one call has the same `updated_at`, and a call that started first can commit last. |

### record_history

Every version the server has taken, one row each, never changed afterwards. A signed record is not rewritten: when one changes, its new version is added beside the old.

| Column | What it is |
|---|---|
| `company_id`, `kind`, `id` | The record. |
| `version` | 1 for the record's first version, then 2, 3 and on; with the record, the key. Counted per record rather than from one sequence for every company, so a number says nothing about how much other companies send. |
| `seq` | The company's number for this version, as on `records`. Counted per company for the same reason. Within a company it does tell a member how many versions were sent between two they can read, kinds they cannot read included. |
| `rev`, `base` | The version, and the one the sending phone last had confirmed (null for none). |
| `data` | The record as it was sent, or null for a deletion. |
| `deleted` | Whether this version is a deletion. |
| `by`, `at` | The account that sent it, and when the server took it. `by` is cleared if that account is deleted. |

A trigger refuses every change to a version and every removal through SQL, by anyone, and TRUNCATE too. Two things get through: deleting the company takes its records and their history with it, and deleting an account clears `by` (its foreign key does that, and only once the account is gone) and changes nothing else. Every version belongs to its record (a foreign key), so while its company stands, a record cannot be deleted either. The trigger stops mistakes and every write through the API, the server key's included; it does not stop the database's owner, who can disable or drop it, and the server key can still delete a whole company, history and all. An audit trail that must hold even against the owner has to be copied somewhere the owner cannot change. In PL/pgSQL write the column as `"by"`: a bare `by` reads as a keyword there.

Two more tables are `push_records`' own, and only the server key reads them: `record_counters`, each company's latest `seq`, and `record_usage`, how much each account has sent today.

### Sending records: push_records

`push_records(company_id, changes)` takes up to 200 changes, each `{key, kind, id, rev, base?, record}` as `changesToSend` makes it, and answers with the ones it took, the ones it set aside and, only when there are any, the ones it left for a later call:

```json
{
  "accepted": [{ "key": "mrf:m-17", "rev": "0f3c9a1b2d4e5f607182", "conflict": true }],
  "ignored": [{ "key": "employee:e-4", "rev": "9a1b0f3c2d4e5f607182", "reason": "supervisor_only" }],
  "deferred": [{ "key": "exam:x-9", "rev": "2d4e5f6071820f3c9a1b", "reason": "call_size" }]
}
```

The phone marks `accepted` and `ignored` as sent (`markSent`, `readPushAnswer`): it stops sending those, and for an ignored one the server keeps what it had. A deferred change is in neither, so the phone sends it again in its next round. The changes are taken in order, in one transaction. A call whose changes are not a list, or that has more than 200, is refused whole (`22023`). Anything else wrong with one change sets aside that change only, so one bad record never stops the rest of a phone's records:

1. **Shape** (`malformed`, with a `problem` naming the change and what is wrong, such as "Change 3 has a key that is not its kind and id."; or `unknown_kind`). A change that is not an object, a kind the server does not keep, a key that is not `kind:id`, an id or rev out of bounds, a base that is not a rev, a record that is not a JSON object (or not null for a deletion), settings with an id other than `company`, or a record holding a number no phone sends. The key and rev come back as sent when they are text, and as null when they are not.
2. **Twice in one call.** The same key with the same rev gets the same answer; with another rev it is set aside (`duplicate`). One call writes one version of a record.
3. **Size** (`too_large`): see [Size](#size).
4. **Private** (`private`), whoever sends it: a record with a field named `payRates`, `payRate`, `passwordHash`, `salt`, `rate` or `hourlyRate`, in any capitals and at any depth (`settings.company.payRates`, an employee's `pay.rate`), and settings with any field but the four shared ones.
5. **A supervisor's** (`supervisor_only`): the settings, the roster (`employee`), the area sheets, paid leave, any deletion, a new unit in the fleet, and a new maintenance request that is not open and unassigned the way the app makes one (`20261117000900`): its `status` is not `open`, it names who it is assigned to, it carries something completing it writes (`completedAt`, `completedBy`, `timeSpent`, `remarks`; null is the same as left out), or its `history` is not a list (left out and null are fine) or has an entry that is not `open` or names who it is assigned to.
6. **Bounds** (`deferred`, reason `call_size` or `daily_limit`). Once a call has taken 8 MB of records, or the caller's account has sent 20,000 versions or 64 MB of records today (UTC), that change and every one after it in the call wait. What the server already has is still answered, and the count starts again the next day. The limits are constants at the top of `push_records`; a company whose phones send more than that in a day (a big crew's first sync after months offline, say) finishes the next day.
7. **What the server has.** The record is locked, after the company's row in `record_counters`, so one company's calls take turns from there until they commit.
   - The server has this version already, or this is the caller's own latest change to the record sent again (the same rev and base: a batch retried after its answer was lost): accepted, and nothing is written. Matching rev and base, not rev alone, still lets a record come back to an earlier version of its own (ready, red tag, ready, red tag).
   - The record is deleted: only a supervisor brings it back (`deleted`). Bringing back a record by the same id, such as an area sheet whose id is its name, is a supervisor's.
   - A change with no base onto a record the server has is a copy, not an edit (`copy`): always for the settings, the roster, the fleet and the area sheets, which every phone of a build starts with, and for the other kinds whenever someone else wrote the server's version. A new phone's fleet therefore never resets a red tag. For a shift, punch, checklist, log, exam, request or leave entry that another account sent first, the reason is `taken` (the phone made a record under an id that is not free); for the caller's own that someone else has changed since, `superseded`.
   - A member's change made from a version other than the server's, when someone else wrote the server's (`superseded`). An employee's phone that has not seen a supervisor's correction, a deletion or a date fixed does not undo it: the server keeps the supervisor's version as current.
8. **What a member may change** in a record already on the server. A supervisor changes anything. A member, who never deletes:

   | Kind | A member may | Otherwise |
   |---|---|---|
   | `shift` | On their own, while it is open: clock out, add a lunch (it ends by itself) and a break, end a break. No time already on it moves, nothing is taken off, a correction (`edits`) is a supervisor's, and once clocked out it does not change. | `signed`; someone else's: `not_yours` |
   | `denied` | Nothing: a turned-down punch is kept as it was. | `signed` / `not_yours` |
   | `inspection` | On their own checklist: what they decided after a defect, once, and the request it was sent on (`decision`, `mrfId`). | `signed` / `not_yours` |
   | `exam` | On their own exam: a date fixed on a line, once (the first date stands), and the request a line was sent on (`fixed`, `mrfId`). | `signed` / `not_yours` |
   | `opLog` | Their own log until it is checked in, its start left as it was; another operator's open log, ended (`endAt` and `endMeter` added, nothing else), as a new operator taking the unit does. | `signed` / `not_yours` |
   | `mrf` | The work on a request not yet completed and assigned to someone: `status`, `remarks`, `timeSpent`, `completedBy`, `completedAt`, and `history` added to. Who it is assigned to and what it is about are a supervisor's, and so is an added `history` entry that names who it is assigned to. With nobody assigned (no `assignedTo`, or one that is not a name), the work is a supervisor's too, all of it: a member changes nothing on it, so does not start it, move it back to open, complete it, write what completing it writes or add to its `history` (`20261117000900`). With someone assigned, any member may still work it and complete it, with any name as `completedBy`: see [Whose a record is](#what-the-server-works-out-and-what-it-does-not-check-yet). | `supervisor_only` |
   | `equipment` | A unit's `status`, and its `meter`, never down. | `supervisor_only` |

   "Own" means the caller's account sent it first, as an employee.
9. **Write.** The record is written and the version added to the history, each with the company's next `seq`. A change made from a version other than the one the server had (a supervisor's, a supervisor bringing a record back, or the caller's own on top of their own after a lost answer) is still written, and its accepted entry carries `"conflict": true`.

A deletion (`rev: "deleted"`, `record: null`) keeps the row, marked deleted and emptied, and adds the deletion to the history. A supervisor's deletion of a record the server never had writes nothing and is accepted. An employee's deletion gets `supervisor_only` whether or not the record is there, so a deletion tells nobody which ids exist; it also means a phone dropping old denied punches (the app keeps the last 200) never deletes them on the server.

The caller must be an active member of the company. An account that is not, a member taken off the roster and a company that does not exist all get the same `PT404` ("No such company.", HTTP 404). anon cannot call it at all.

Who may send what, in short:

| Kind | Sends a new one | Changes one already there | Deletes |
|---|---|---|---|
| `settings`, `employee`, `areaSheet`, `leave` | a supervisor | a supervisor | a supervisor |
| `equipment` | a supervisor | a supervisor; any member: status and equipment hours | a supervisor |
| `shift`, `denied`, `inspection`, `exam` | any member | a supervisor; the member who sent it, as the table above allows | a supervisor |
| `opLog` | any member | a supervisor; its operator until checked in; any member, to end it | a supervisor |
| `mrf` | a supervisor; any member, open and unassigned | a supervisor; any member: the work on one assigned to someone, until completed | a supervisor |

A client that writes records the way a phone does (the office dashboard, say) sends the rev it read as `base`. Without one, a change to a record someone else wrote is a copy and is set aside.

### Size

jsonb keeps a number such as `1e131071` in a few bytes, and its text is 131,072 characters: a record of a few thousand of them would take a gigabyte to write out. So a record's size is checked without writing it out first, in this order: at most 1 MB as stored, no number a phone never sends (`JSON.stringify` writes nothing past ±1.8e308, and nothing nearer zero than 5e-324; such a record is `malformed`), and only then at most 256 KB as JSON text (`too_large`). The tables' own check constraints do the same, and so does the pay period's (`20261117000400`: 64 KiB stored, the same numbers, 16 KiB as text). A company logo kept in the settings as an image data URL is the record likeliest to pass 256 KB; the server sets such settings aside rather than stopping the phone, so the app should keep the logo well under that before it sends.

### Reading records

Through the tables (`supabase.from('records').select()`), by row level security:

- A supervisor reads every record of the company and every version of each.
- Any member reads the records the crew works from, `settings`, `employee`, `equipment`, `areaSheet`, `inspection`, `opLog`, `exam` and `mrf`, and every version of them.
- A member reads the `shift` and `denied` records their own account sent first as an employee, and every version of those, a supervisor's corrections included, and nobody else's. Paid leave is entered by a supervisor, so a member reads none, their own included.
- A supervisor reads the company's records only while the company has MineMuster (`company_has_access`); without it they read none, not even what the crew reads. What the crew reads does not depend on billing, and nobody's sending ever does. See [What a supervisor reads](#what-a-supervisor-reads).
- Nobody reads another company's records. anon reads nothing. The server key reads the four tables and writes none.

As every policy here does, the two compare a row's company with the caller's own companies (`member_company_ids()`, and `supervisor_company_ids()` for what a supervisor reads), worked out once per statement, and call no function on each row: a request reads no row of another company, and takes no longer for a company with more records. What a member may not read is filtered from their own company's rows only.

`my_companies()` lists the companies the caller belongs to, for the app and the office dashboard to pick one: `id`, `name`, `state`, the caller's `role` there, and `join_code` where they are a supervisor (null elsewhere; an employee can still read the code from `companies`, as before). It counts membership as `is_member` does, so an account Supabase Auth has banned or soft-deleted belongs to none.

### Pulling what changed

Page by `seq`, never by `updated_at` or by offset:

```js
const { data } = await supabase
  .from('records')
  .select('*')
  .eq('company_id', companyId)
  .gt('seq', lastSeq)
  .order('seq')
  .limit(1000);
// then lastSeq = the last row's seq, and repeat until a page comes back short
```

A company's calls take turns on its `record_counters` row, held until each commits, so a version with a higher `seq` became visible after every lower one: a pull never misses a version that committed late, and a record changed between two pages comes back on a later page at its new `seq`. The same goes for `record_history`. Keep the highest `seq` read, not the time.

### What the server works out, and what it does not check yet

- **A date fixed through a request.** The app writes the date a condition was fixed onto the exam when the person assigned completes the request it was sent on, and the request's id onto the exam line or checklist it came from. The server takes those only from the exam's or checklist's own maker or a supervisor. The completed request holds the same facts (`examId`, `findingKey`, `inspectionId`, `completedAt`, `completedBy`, `remarks`), so a condition is fixed on the server when its exam line has `fixed`, or a completed `mrf` names that exam and line. The dashboard should read both.
- **A unit's status and hours.** Every phone holds its own copy of the fleet and does not pull, so after the first change to a unit, other phones' changes to it are set aside as copies or as superseded, and the server's `equipment` is only as current as its last writer. A unit is tagged out while an `mrf` for it is open with `taggedOut`; its latest equipment hours are in its latest `inspection` (`meter`) and `opLog` (`endMeter`). The dashboard should work those out rather than trust `equipment.status` and `meter`.
- **Whose a record is.** The server goes by the account that sent it, not by the person it is about: it does not check that a shift's `employeeId` is the sender's, that a request is worked by the person it is assigned to, or that "completed by" names that person. For a maintenance request it holds what it can tell without that (`20261117000900`): a member's new request is open and unassigned, a request nobody is assigned to is worked only by a supervisor (started, moved back, completed), and no member's history entry names who it is assigned to. A request assigned to someone is still worked and completed from any member's account, with any name as `completedBy`; the app does not allow that (`canWork` in `src/store/useStore.ts`). The two-way sync work, which links each server account to the app's employee id, closes it. A shift a supervisor enters for someone is the supervisor's: that person's account cannot change it and does not read it. Linking each account to the app's employee id would let the server check these.
- **A phone connected with a crew account.** What a phone sends is judged by the account it is connected with, not by who is signed in to the app, so a shared phone connected with an employee's account cannot send a supervisor's work. The phone counts what the server will not take from its account as sent and does not send that version again (`readPushAnswer`), and says nothing (see **Phones do not yet show**, below). For a maintenance request on such a phone, since `20261117000900`:
  - A supervisor signed in to the app who assigns a request (as before), or starts or completes one nobody is assigned to, changes it on that phone only. The server keeps the request as it had it, and the remarks, which are the repair record, stay on the phone.
  - When that request came from a pre shift exam the same account sent, the date fixed that completing it writes on the exam is still taken (the exam's maker may record it). The server then has the exam line fixed and its request open, without the remarks.
  - A request made on such a phone and assigned or completed there before the phone first sends it is set aside whole. The phone sends only a record's latest version, and that version is not open and unassigned, so the server never has the request, not even the open one the crew member made, and the `mrfId` on the checklist or exam line it came from names a request the server does not have.

  The two-way sync work has to carry these: an account linked to the app's employee id, and a change the server set aside for its account kept on the phone, and shown, until it can be sent (sending the open version of a new request ahead of a later one would keep the crew member's own request), rather than counted as sent.
- **Payroll ids.** Every member reads every `employee` record, `payrollId` included, and every version of it; the app shows `payrollId` on supervisor screens only. Row level security cannot hide one field of a JSON record: keeping it from members needs a supervisor-only place for it, or a member's view of the roster without it.
- **Removing a version.** Nothing removes one version, a leaked field or a person's data included, short of deleting the company. Who may redact an audit trail, and how that is recorded, is still to be decided.
- **Phones do not yet show** a `conflict`, a reason in `ignored`, or a `deferred` list; `readPushAnswer` reads `accepted` and `ignored` only.

## Billing

Step 3: what a company pays. MineMuster is $300 a month per company, the whole crew included, with a 14-day free trial. A supervisor starts the trial at a Stripe payment link from the office dashboard: the card is taken there, and Stripe charges it automatically when the trial ends, then every month until the company cancels in Stripe's billing portal. Cancelling stops the next charge, and the company keeps access to the end of the period already paid for. Prices are in US dollars. Stripe keeps the cards, the invoices and the charges; the server keeps only where each company's subscription stands, from what Stripe tells it. The migration is `20261117000500_billing.sql`.

Stripe tells the server through a webhook: the edge function `functions/stripe-webhook` checks that a request really is from Stripe and hands the event to `apply_stripe_event` with the server key (see [The webhook](#the-webhook)). The office dashboard asks `company_billing` where its company stands, and opens its supervisor pages by that answer.

The Stripe account is shared with another business, whose products and events reach the same webhook. Only MineMuster's events change anything:

- A **checkout** is MineMuster's when the checkout session carries the metadata `app` = `minemuster` (Stripe copies a payment link's metadata onto every session it makes) and its `client_reference_id` is the id of a company on this server. The dashboard puts the company's id there when it builds the trial link. That is what ties a subscription to a company.
- A **subscription event** is MineMuster's when the subscription carries the metadata `app` = `minemuster` (the payment link sets it on the subscriptions it makes), or when it is a subscription a MineMuster checkout already brought in.
- Anything else is recorded as seen (its id, type and why it changed nothing) and changes nothing. Nothing else about another business is kept.
- So is every event from Stripe's **test mode** (`livemode` not `true`), whatever it is: a checkout paid with a test card never opens a real company. Test the integration against another Supabase project.

### billing_subscriptions

One row for each MineMuster subscription in Stripe.

| Column | What it is |
|---|---|
| `subscription_id` | Stripe's id for it (`sub_...`). The key. |
| `company_id` | The company its checkout named. Null until that checkout is seen, since Stripe can send the subscription's own events first. Set once: the first link stands. Deleting the company deletes its rows. |
| `customer_id` | Stripe's customer (`cus_...`). |
| `status` | Stripe's status: `trialing`, `active`, `past_due`, `canceled`, `unpaid`, `paused`, `incomplete` or `incomplete_expired`. Null while only the checkout has been seen. |
| `trial_end`, `current_period_end` | When the trial ends (and the first charge is made), and when the period already paid for ends. |
| `cancel_at_period_end` | The company has cancelled: nothing more is charged, and the subscription ends at `current_period_end`. |
| `event_at` | Stripe's `created` time of the newest event applied to the status. |
| `created_at`, `updated_at` | When the row was made and last changed. |

### billing_overrides

A company the owner lets in without paying: a pilot, a friend of the business, a company whose card trouble is being sorted out. One row per company: `reason` (1 to 500 characters, required), `until` (null for good), `created_at`. The company's supervisors can read the row, reason included, so write the reason for them to see.

### stripe_events

Every event the webhook has handed over, MineMuster's or not: `id` (`evt_...`), `type`, `outcome` (`applied`, or why it changed nothing) and `received_at`. An event Stripe delivers twice is applied once. No API role reads it, the server key included. The owner can read it in the table editor to see what Stripe sent and what was done with it.

### Stripe's events

`apply_stripe_event(p_event)` takes one event, already checked against Stripe's signature, and answers what it did:

| Event | What it does |
|---|---|
| `checkout.session.completed` | With `mode` = `subscription`, the MineMuster metadata and a `client_reference_id` that is a company here: ties `data.object.subscription` to that company (making the row if the subscription's own events have not yet). A subscription already tied to another company stays with it. |
| `customer.subscription.created`, `.updated`, `.deleted` | For a MineMuster subscription: sets its status, trial end, period end (`current_period_end` on the subscription in older Stripe API versions, on its first item in newer ones), `cancel_at_period_end` and customer, unless the event is older than the one the subscription is at. |
| anything else | Nothing. |

Its answer is `{applied: true, type, subscription_id, ...}` when it changed a subscription, or `{applied: false, reason}`:

| Reason | Means |
|---|---|
| `duplicate` | The event was handed over before. |
| `test_mode` | An event from Stripe's test mode (`livemode` is not `true`). Set aside before anything in it is read. |
| `ignored_type` | Not a kind of event MineMuster uses. |
| `not_minemuster` | Another business's checkout or subscription. |
| `not_subscription` | A MineMuster checkout that is not for a subscription. |
| `no_company` | A MineMuster checkout whose `client_reference_id` is not a company here. Tie it by hand (below). |
| `no_subscription` | The event names no subscription. |
| `already_linked` | The subscription is already another company's. |
| `unknown_status` | A status this migration does not know. Nothing changes; a new migration should learn it. |
| `no_time` | A subscription event with no `created` time. |
| `stale` | Older than the event the subscription is at. Stripe does not promise to send events in order. |
| `ended` | The subscription has ended in Stripe (`canceled`, `incomplete_expired`), which never starts again; only another ending is taken. |

It raises (`22023`) only for something that is not a Stripe event at all (not an object, or no id or type), and never for another business's event, so the webhook answers Stripe 200 and Stripe stops sending it. Times arrive as Unix seconds; one that is not a number between 1970 and the year 3000 is taken as none. Each event runs in one transaction, so a failure leaves nothing half done and Stripe's retry starts clean. Two deliveries of one event at once take turns, and the second finds the first; two events for one subscription at once take turns on its row, and the newer one stands (`billing_races.db.mjs`).

### Where a company stands

`company_billing(p_company_id)` is for the company's supervisors (an account Supabase Auth has banned or soft-deleted is none); anyone else is told there is no such company (`PT404`, HTTP 404), as by every supervisor function. It answers:

```json
{ "access": "trial", "status": "trialing", "trial_end": "2026-12-01T17:00:00+00:00", "current_period_end": "2026-12-01T17:00:00+00:00", "cancel_at_period_end": false, "running": 1, "had_trial": true }
```

| `access` | When |
|---|---|
| `comped` | The company has a `billing_overrides` row with no `until`, or one still to come. |
| `active` | A subscription is paid up. |
| `past_due` | A charge failed and Stripe is trying the card again. Still let in. |
| `trial` | The company's first free trial is running; or a checkout was done in the last hour and its subscription's own status has not come in yet. Checkout completes only once the card is taken, and the next event sets the real status, usually within seconds. |
| `ended` | Every subscription has ended (`canceled`, `unpaid`, `paused`, `incomplete` or `incomplete_expired`), or the only one still running is a second free trial. |
| `none` | No subscription, or only a checkout whose subscription never said its status (after that hour). |

**One free trial for each company.** A `trialing` subscription counts only when no other subscription of the company that had a trial was made before it. So starting a trial, cancelling it and starting another gives no second 14 days: the second shows as `ended` with status `trialing`, and opens the dashboard once Stripe charges it at the end of that trial. A company that has had its trial starts again on a payment link with no trial (the dashboard's `RESTART_LINK`, which charges the card at checkout). Two trials started at once (two supervisors, two tabs) count once.

**The subscription it goes by**, whose `status` and dates it gives (when the company is comped too), is the first of: one that is `active`, one that is `past_due`, the first trial, a checkout of the last hour, a second trial; and only when there is none of those, the newest (by `event_at`, then `updated_at`). So a company with a running subscription is never shut out by one that ended, such as a second checkout made by mistake and cancelled, and a checkout someone else made with the company's id (a payment link opened with it) cannot change what a paying company is told.

`running` is how many of the company's subscriptions Stripe will charge again: `trialing`, `active` or `past_due` and not cancelled, and a checkout of the last hour. More than one means the company is charged more than once a month; the dashboard says so. `had_trial` is true when a subscription of the company has had a free trial, the one it goes by included, so a new checkout would get no trial that counts.

The dashboard opens its supervisor pages on `trial`, `active`, `past_due` and `comped`, loads the records only then, and lets the supervisor in without an answer only when the server has no `company_billing` at all (`dashboard/src/lib/billing.ts`). To look for a company charged twice by hand:

```sql
select company_id, count(*) from public.billing_subscriptions
where status in ('trialing', 'active', 'past_due') and not cancel_at_period_end
group by company_id having count(*) > 1;
```

### What a supervisor reads

What a company pays for is checked on the server, where the dashboard's own code cannot skip it. `company_has_access(company_id)` is true for `comped`, `trial`, `active` and `past_due` (it is `company_billing`'s answer, through `billing_standing`, which no API role calls). A restrictive policy on `records` and on `record_history` (`records_select_paid`, `record_history_select_paid`) lets a row be read only from the caller's `records_open_company_ids()`: every company they belong to, but one they supervise only while it has MineMuster. Like every policy here, it compares the row's company with an array worked out once per statement and calls no function on the row. The array is worked out in one pass over the caller's roster rows (migration `20261117000700`): a company where the caller is a member and either not a supervisor or the company has MineMuster. Before, it asked `supervisor_company_ids()` again for each of the caller's companies, so its cost grew with the square of their number, and an account in about 1,400 companies took a call past the 8 s statement timeout. `membership_reads.db.mjs` holds it, and the other membership functions, to the answers of the definitions they replaced, case by case, and an account in 1,000 companies to well inside the timeout.

- A supervisor of a company without MineMuster reads none of its records, through the table or PostgREST. They still read the company, its roster, its join requests and its billing, so the Billing page works.
- Sending is never stopped: `push_records` does not look at billing, so a phone never loses a safety record, and they are all there once the company is let in again.
- What a member who is not a supervisor reads is unchanged. No phone reads records today; whether the crew's reads should stop too is the owner's call, a change to `records_open_company_ids` alone.
- There is no "billing not set up" exception on the server: billing arrives with this same migration, so wherever `company_has_access` exists, so does billing. A company that already uses the dashboard when this migration is applied reads its records again once it starts its trial, or once the owner adds its `billing_overrides` row (below), which is best done in the same sitting.

### Letting a company in without paying

In the SQL editor, which runs as the owner. Find the company's id first:

```sql
select id, name, state, created_at from public.companies order by name;
```

Let it in until a date, or for good with `until` left null:

```sql
insert into public.billing_overrides (company_id, reason, until)
values ('<company id>', 'Pilot through the spring', '2027-04-01')
on conflict (company_id) do update set reason = excluded.reason, until = excluded.until;
```

End it early with `delete from public.billing_overrides where company_id = '<company id>';`. Once `until` has passed, the row counts for nothing and the company goes by its subscription again.

A checkout that came in with no company (`no_company` in `stripe_events`, say a payment link opened without the dashboard) can be tied by hand once you know whose it is, from the customer in Stripe:

```sql
update public.billing_subscriptions set company_id = '<company id>'
where subscription_id = '<sub_...>' and company_id is null;
```

### The webhook

`functions/stripe-webhook` is a Supabase edge function (Deno), in three files: `index.ts` starts it, `handler.ts` is what it does, and `verify.ts` checks Stripe's signature. They use nothing but Web Crypto and `fetch`: no Stripe SDK and no supabase-js.

1. It takes `POST` only (405 otherwise).
2. It reads the `Stripe-Signature` header and checks its time before anything else, so a request that is not from Stripe costs no call to the database: 400 for a header that is missing, is not one Stripe sends, or was signed more than 300 seconds from now either way.
3. The signing secret is the function's `STRIPE_WEBHOOK_SECRET` when that is set, or else what `stripe_webhook_secret()` reads from Supabase Vault, kept for a minute.
4. It checks the signature as Stripe documents it: each `v1` is the HMAC-SHA256 in hex of `t.body` (the raw bytes Stripe sent), any `v1` may match, compared in constant time. 400 when none does.
5. It sends the event to `apply_stripe_event` through PostgREST with the server key, and answers Stripe 200 with what that answered, for an event set aside as well, so Stripe stops sending it. When the database cannot take the event (it cannot be reached, refuses the key, or does not have the function yet) it answers 500, and Stripe sends the event again later, for up to three days.

The server key is the `default` entry of `SUPABASE_SECRET_KEYS` (an `sb_secret_...` key, sent as `apikey` only, as Supabase asks), or else the legacy `SUPABASE_SERVICE_ROLE_KEY` (a JWT, sent as `apikey` and as the bearer token). Supabase sets both for its edge functions (Edge Functions, Secrets lists them). The log says what failed and never a secret, a key or an event's body.

**Where the signing secret lives.** In Supabase Vault, under the name `stripe_webhook_secret`, which keeps it encrypted in the database and out of the repository. The owner adds it once, in the SQL editor (or on the dashboard's Vault page):

```sql
select vault.create_secret('<whsec_... from the Stripe webhook endpoint>', 'stripe_webhook_secret', 'Signs the Stripe events MineMuster takes');
```

Only `stripe_webhook_secret()` reads it, and only the server key may call that. An edge function secret named `STRIPE_WEBHOOK_SECRET` (Edge Functions, Secrets) works as well and comes first when both are set. To roll the secret in Stripe, keep the old one valid for a while, put the new one in Vault (`select vault.update_secret(id, '<new whsec_...>') from vault.secrets where name = 'stripe_webhook_secret';`) or in the function's secret, and the webhook takes it within a minute. Never put a signing secret, a Stripe key or a server key in the repository.

**Deploying it.** JWT verification has to be off, because Stripe sends no Supabase token; the signature is the check. With the CLI, from the repository root: `supabase functions deploy stripe-webhook --no-verify-jwt`. Through the Supabase MCP server or the dashboard, deploy the three files `index.ts`, `handler.ts` and `verify.ts` with `verify_jwt` off. In Stripe, add a webhook endpoint at `https://<project-ref>.supabase.co/functions/v1/stripe-webhook` for these events only: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`. Its signing secret is the one to keep in Vault.

**What to check once.** That both payment links (the 14-day trial, and the one with no trial for a company starting again) carry the metadata `app` = `minemuster` and put the same metadata on the subscriptions they make (Stripe's payment link "subscription data"). Without it on the subscription, a subscription event that arrives before its checkout is set aside for good as `not_minemuster`, its cancellation included. Then that a live checkout shows up in `stripe_events` with the outcome `applied` and in `billing_subscriptions` with its company (cancel it in the portal afterwards). An event from Stripe's test mode only ever shows `test_mode` here, so a test card cannot show the whole path; test that against another Supabase project.

`npx tsc -p supabase/functions` type checks the function as Deno runs it (`functions/tsconfig.json`). The app's own `npm run typecheck` leaves `supabase/functions` out, because the files import each other with their `.ts` extension, as Deno needs.

## The contact form

The contact form on minemuster.com sends what a visitor typed to `submit_contact_request(p_name, p_company, p_email, p_phone, p_message, p_website)`, with the publishable key and nobody signed in (`POST /rest/v1/rpc/submit_contact_request` with the six as a JSON object). It answers `{ok: true}`.

- `p_website` is a field people never see. A form that fills it in is a bot: it is answered `{ok: true}` and nothing is kept.
- A field far over its limit is turned back before anything else is done with it (a name over 1,000 bytes, an email over 1,500, a message over 20,000, a company over 1,000, a phone number over 500), with the hint of that limit. Cleaning costs time for each character, and a refused call counts toward no limit, so a huge request costs the database next to nothing.
- Each field is trimmed and cleaned of control characters and of characters that show nothing: the same default-ignorable and format characters a name on the roster may not hold (zero-width spaces and joiners, direction marks, overrides and isolates, the soft hyphen, variation selectors, the Hangul and braille fillers, tag characters and the like). The message keeps its line breaks and tabs; the other fields are one line each, with runs of spaces closed up.
- Then it is checked. A name of 1 to 120 characters, an email address that looks like one (a part before the `@`, a domain with a dot, at most 254 characters), a message of 1 to 4,000 characters, and a company of at most 160 and a phone number of at most 40, both optional.
- The limits, so that one sender cannot shut the form for everyone and the table cannot be flooded: at most 3 messages from one email address (whatever its capitals) in 24 hours; at most 5 from one sender in an hour, the sender being the network address the request came from (the first entry of `X-Forwarded-For`, as Supabase documents the client's address); and at most 100 from everyone in an hour, a backstop for storage alone. Calls take turns from the counting to the commit, so two at once cannot both slip under a limit (at READ COMMITTED, as PostgREST runs).
- The sender's address is never kept. `contact_senders` holds a hash of it made with a key of this server's own (`contact_sender_key`, made at random by the migration), so the hashes cannot be turned back into addresses by trying them all, and each row is deleted by the next message once it is an hour old. A call with no such header (the SQL editor, say) counts only toward the other two limits.

When it turns a message back, the error's code and hint say why, and its message can be shown as it is:

| Code | Hint | Message |
|---|---|---|
| `22023` | `name_missing` | Type your name. |
| `22023` | `name_too_long` | Keep your name to 120 characters. |
| `22023` | `email_invalid` | Type an email address we can write back to. |
| `22023` | `message_missing` | Type a message. |
| `22023` | `message_too_long` | Keep the message to 4,000 characters. |
| `22023` | `company_too_long` | Keep the company name to 160 characters. |
| `22023` | `phone_too_long` | Keep the phone number to 40 characters. |
| `PT429` (HTTP 429) | `too_many` | Too many messages. Try again later. |

**Reading them.** What it keeps is in `contact_requests` (`name`, `company`, `email`, `phone`, `message`, `created_at`, `handled`). No API role reads it but the server key, so no visitor reads anyone's message, their own included. The owner reads it in the dashboard's table editor, or in the SQL editor:

```sql
select created_at, name, company, email, phone, message
from public.contact_requests where not handled order by created_at;

update public.contact_requests set handled = true where id = '<id>';
```

Nothing tells the owner when a message arrives; check the table, or add a notification later. What is left: a script that writes a new `X-Forwarded-For` into each request, if Supabase's gateway passes the first entry on as the client sent it, counts as a new sender each time, and so could still fill the 100-an-hour backstop and hold off real messages for that hour. A challenge on the form (Cloudflare Turnstile, checked by a small edge function before the insert) closes that; it needs the site as well as the server. The website's privacy page should say that the server counts messages by the address they came from, keeping only a scrambled form of it for an hour.

## Running the tests

They need Node 22 or newer, and nothing else: no Supabase account, no Docker, no network once installed.

```bash
cd supabase/tests
npm install
npm test
```

`npm test` runs `node --test *.db.mjs`. Each test file starts a fresh PGlite database. It first makes stand-ins for what every Supabase project already has (`tests/supabase-stub.mjs`): the `auth` schema with `auth.users` (with the `deleted_at` and `banned_until` columns the guard reads), `auth.uid()` and `auth.jwt()`, the roles `anon`, `authenticated` and `service_role`, Supabase's default grants on schema `public`, and a table standing in for Vault's `vault.decrypted_secrets` view, which PGlite does not have. It then applies every migration in order and makes its requests the way the API does, as the role `anon` or `authenticated` with the account's id in `request.jwt.claim.sub` (and, where a test gives them, the request's headers in `request.headers`). Every test makes its own companies and accounts, so none depends on another. A company made by `startCompany` is let in without paying (a `billing_overrides` row), since a supervisor reads records only while the company has MineMuster; the billing tests pass `comped: false` to start with none. `startDatabase({ owner })` in `tests/harness.mjs` applies the migrations as a non-superuser owner instead, as Supabase's `postgres` is, so a statement that would need a superuser there fails here too.

There are 435 tests, in about a minute, and 32 more that need a real server (below):

| File | What it holds to |
|---|---|
| `companies.db.mjs` | Starting a company, how many one account may start (3 in any 24 hours, 20 in all, `PT429` with its hint past either), the join code and its alphabet, rotating it, company settings |
| `join.db.mjs` | Every `join_company` status, reading codes, claiming a row only once |
| `join_hardening.db.mjs` | A supervisor row is never claimed by name, a removed person waits for approval, a name that fits a removed person (exactly or the looser way) never lands on an active namesake, identical names leave a request, hidden characters are refused, joining settles a stale request |
| `join_holds.db.mjs` | A released or deleted claim holds its account, `replace_claim` hands a row over in one step, taking someone back settles their request, joining keeps the request it settles, a bar keeps an account out until it is lifted, and lifting it leaves a release in place |
| `name_hygiene.db.mjs` | Every invisible character is refused, a decomposed spelling is the same name, a name cannot mix alphabets, a name that only looks like one on the roster is refused when typed or written, names that only differ are not, and a stricter rule never blocks an older row |
| `requests.db.mjs` | Approving onto a row or a new one, denying, deciding once, supervisors only |
| `request_privacy.db.mjs` | A non-member reads no id of another company through its own requests; `my_join_requests()` hides `decided_by` and `roster_id` |
| `anonymous.db.mjs` | An anonymous sign-in cannot join or start a company |
| `isolation.db.mjs` | A member of one company sees and changes nothing of another, and the errors say nothing about it |
| `employee.db.mjs` | What an employee cannot do, and what nobody writes through the API |
| `supervisor-guard.db.mjs` | The last supervisor, on every path, counting only accounts that can still sign in; a banned or soft-deleted account has no power left; `is_last_supervisor` and `step_down_everywhere` |
| `concurrency_guard.db.mjs` | The guard writes a row per company before it counts, approving and denying take the per-account lock first, and the server key cannot `TRUNCATE` a table |
| `races.db.mjs` | Needs a real server: two supervisors stepping down at once, or stepped down by the server at once, at each isolation level; approving a request while the person types a name; releasing, deleting or reactivating a removed person's row while they type one; renaming a row while its old name is typed; and one account starting two companies at once at the edge of its limit |
| `record_races.db.mjs` | Needs a real server: two `push_records` calls from one company take turns, so `seq` order is commit order; two calls making the same new record; REPEATABLE READ is told to try again; two companies do not wait for each other; and the one 40001 `push_records` raises itself, when the owner writes the record between its read and its write, is answered at once when the call is made again |
| `planner_statistics.db.mjs` | The planner's estimates say nothing about another company's size, names or ids |
| `row_reads.db.mjs` | No policy calls a function on each row, a request reads no row of another company, and how long it takes says nothing about another company's size, names or ids |
| `membership_reads.db.mjs` | The caller's companies in one pass: each membership function gives the answers of the definition it replaced (inactive rows, banned or soft-deleted accounts, supervisors and crew of companies with and without MineMuster, several companies, nobody signed in) with the same settings and grants, reads the caller's id a few times a call however many companies it is in, and an account in 1,000 companies reads its records well inside the 8 s statement timeout |
| `extension_in_public.db.mjs` | The migrations apply as a non-superuser owner with an extension in `public`, and leave its functions alone |
| `project_objects_in_public.db.mjs` | The migrations apply over the project's own procedure, aggregate and sign-up trigger function in `public`, and leave them alone, so sign-ups keep working |
| `anon.db.mjs` | `anon` calls `company_by_code` and the contact form and nothing else, and reads nothing |
| `names.db.mjs` | Name matching, against `findOnRoster` itself, Greek names in capitals included; one `todo` test shows what `roster.ts` still has to fold the same way |
| `notifications.db.mjs` | One for each join and new request, seen by that company's supervisors only |
| `security.db.mjs` | `search_path` (pg_catalog first, pg_temp last), EXECUTE grants, that every raise, whatever its shape, is a code PostgREST answers with a 4xx and a `PTnnn` code's message a constant on one line, row level security, each role's privileges, no planner statistics on any column, and that the migrations leave Supabase's own schema and roles alone and only ever read Vault |
| `records.db.mjs` | Sending a record and reading it back, sending it twice, who may write each kind (`supervisor_only`, `not_yours`), private fields, deleting, conflicts, malformed changes and the size limit, who reads what in each company, a history nobody changes or removes, and `my_companies` |
| `billing.db.mjs` | Stripe's events: only MineMuster's change anything, another business's checkouts and subscriptions change nothing, an event delivered twice is applied once, a checkout ties a subscription to an existing company once, an older event never overwrites a newer one and an ended subscription stays ended, odd values never raise; `company_billing` from trial to active to past due to ended, comped with and without `until`, a running subscription before one that ended; one free trial for each company, two trials at once counted once and said to be running, a checkout with no status a trial for an hour only, another person's checkout changing nothing a paying company is told, a comped company told of a subscription still charged; Stripe's test mode set aside; a supervisor reads the records only while the company has MineMuster, the crew as before, and phones send either way; who reads the billing tables and calls the functions; the signing secret from Vault |
| `billing_races.db.mjs` | Needs a real server: the same Stripe event delivered twice at once is applied once, two events for one subscription at once keep the newer, two contact messages at once cannot both slip under a limit |
| `contact.db.mjs` | The contact form: kept for anyone, nothing kept for a bot, fields cleaned of every invisible character, each refusal with its hint, input far over a limit turned back before any cleaning, the limits per email address, per sender and per hour, one sender unable to shut the form for everyone, only a keyed hash of the sender kept and only for an hour, and nobody reads the tables through the API |
| `stripe_webhook.db.mjs` | The edge function under Node: the signature checked against Node's own HMAC, as Stripe documents it (raw bytes, any `v1`, the 300-second tolerance, malformed headers); the handler's answers (405, 400, 500 and 200), which key it sends and how, the secret from Vault kept for a minute; and a signed request all the way to `company_billing` on a local database |
| `record_rules.db.mjs` | A stale phone does not undo a supervisor's correction, deletion or date fixed; copies of the fleet and settings are set aside; what an employee may change in each kind; who completes a maintenance request (a crew account's new one is open and unassigned, one nobody is assigned to is worked by a supervisor only, and what is still taken until the two-way sync work); what an account sent as a supervisor; resent batches; one bad change does not stop the rest; huge numbers, size, duplicates, the per-call and per-day bounds, and the pay period's size; private fields at any depth; reading with no function called on each row; pulling by `seq` |

`names.db.mjs` loads `src/domain/roster.ts` directly (Node strips its types), and Node prints one warning about the module type when it does. That warning is expected. If the file ever cannot be loaded, that one test is skipped and says why.

The tests run on PGlite's PostgreSQL 18. One local database is one session, so two transactions at the same instant cannot be acted out in PGlite. `races.db.mjs`, `record_races.db.mjs` and `billing_races.db.mjs` act them out on a real PostgreSQL server instead, and are skipped (saying why) unless `MINEMUSTER_TEST_DATABASE_URL` names one: a throwaway PostgreSQL 15 or newer server, as a superuser that may create databases and roles. Each file makes its own database there, one at a time (they take an advisory lock while they make it and, on a new server, the API roles), and drops it at the end. Never point it at a Supabase project or at any database whose contents matter.

```bash
MINEMUSTER_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55461/postgres npm test
```

They were last run that way on PostgreSQL 17 (the `supabase/postgres` 17.12 image, as a throwaway server), all three files. In PGlite, `concurrency_guard.db.mjs` reads from the catalog that the guard writes its row and that approving and denying take the per-account lock first.

The app's own `npm test` (Jest) does not pick these files up, because they are named `*.db.mjs`. The app's `npm run typecheck` reads them as plain JavaScript but does not check them. The server tests use the `pg` client, pinned in `tests/package.json`.

## Applying the migrations to a Supabase project

Being done now for the MineMuster project. Never from a test:

1. Apply the files in `migrations/`, in order, once each, to a project on PostgreSQL 15 or newer. New Supabase projects are; `select version();` in the SQL editor shows what an older one runs. The migrations expect what Supabase already provides (the `auth` schema, `auth.users` with its `deleted_at` and `banned_until` columns, `auth.uid()`, `auth.jwt()` and the roles), and they neither create nor change any of it. An extension already in `public` is left alone too. Do not apply anything from `tests/`.
   - With the [Supabase CLI](https://supabase.com/docs/guides/cli), from the repository root: `supabase link --project-ref <project-ref>`, then `supabase db push`. The CLI records which migrations have run, so a later `supabase db push` applies only new ones; `supabase migration list` shows where things stand. (`supabase init` first if the CLI asks for a `supabase/config.toml`.)
   - To try them on Supabase's local stack first: `supabase start`, then `supabase db reset`.
   - Without the CLI: paste each file into the dashboard's SQL editor, in order.
2. Run the dashboard's Security Advisor. It may point out that the functions above are `security definer` and callable by signed-in users, `company_by_code` by `anon`, and `is_last_supervisor` and `step_down_everywhere` by the server key. That is on purpose: each one checks who is calling, and nothing else is callable. It may also point out `company_supervisor_guard` and `join_holds` as tables with row level security on and no policy: that is on purpose too, since only the functions use them.
3. Turn on the sign-in providers in Supabase Auth. The database needs nothing more: it reads the account from `auth.uid()`. If anonymous sign-ins are turned on, `join_company` and `create_company` refuse them (they read `is_anonymous` from `auth.jwt()`), so a throwaway account cannot claim rows or leave requests; still, leaving anonymous sign-ins off keeps that surface closed entirely.
4. Any server code that soft-deletes or bans accounts calls `step_down_everywhere(user_id)` first, and bans only once it has returned, as [A company always keeps a supervisor](#a-company-always-keeps-a-supervisor) says.
5. Keep PostgREST's `db-plan-enabled` off (see [What a count can tell](#what-a-count-can-tell)).
6. For billing (`20261117000500`): keep the webhook's signing secret in Vault as `stripe_webhook_secret`, deploy `functions/stripe-webhook` with JWT verification off, and point a Stripe webhook endpoint at it for the four events it uses, as [The webhook](#the-webhook) says. The Security Advisor may point out `stripe_events` and `contact_requests` as tables with row level security on and no policy, and `submit_contact_request` as callable by `anon`: on purpose, as above.

### Adding to it later

- One new file in `migrations/` per change, named `YYYYMMDDHHMMSS_what_it_does.sql`. Never edit a migration that has been applied; write a new one.
- Lock a new table in the file that makes it: `enable row level security`, `revoke all ... from public, anon, authenticated` and `revoke truncate ... from service_role`. Grant and add policies in the same migration, or in the next one.
- Turn a new table's planner statistics off in the file that makes it, before it holds data: `alter table ... alter column ... set statistics 0` for every column, as `20261116002200_no_planner_statistics.sql` does. A test checks every column of every table in `public`.
- Every new function gets `set search_path = pg_catalog, pg_temp` (pg_catalog first so unqualified type names resolve against it, the temporary schema last so a session cannot shadow a type or relation), fully qualified names, `revoke all on function ... from public, anon, authenticated, service_role`, and a grant to the roles that call it. Supabase grants EXECUTE on every new function in `public` to everyone unless the migration takes it back.
- PostgreSQL checks EXECUTE against the role doing the write, even for a function called from a check constraint or inside a trigger. So constraints use built-in functions only, and a trigger that calls a private helper is `security definer`.
- A trigger that checks a value checks it when that value is written (on insert, or when it changes), not on every update of the row, so a rule made stricter later never blocks an unrelated change to an older row, such as a foreign key clearing a claim.
- Never sweep a schema: name each object a migration alters, as `20261116001600_search_path_hardening.sql` names its functions. On a real project `public` already holds what these migrations must leave alone: an extension's functions (owned by the bootstrap superuser, since on Supabase `postgres` is not one), and the project's own procedures, aggregates and functions, such as a trigger on `auth.users` that finds its tables by the default `search_path`. A loop over the catalog is fine only over a list of names, as `20261116002200_no_planner_statistics.sql` loops over its tables.
- A row level security policy never calls a function on the row's own column. It compares the column with the caller's own companies, worked out once per statement: `company_id = any ((select public.member_company_ids())::uuid[])`, or `supervisor_company_ids()` for what only a supervisor may do. `row_reads.db.mjs` checks the plans.
- Keep the files plain ASCII: write a character such as a no-break space as a regular-expression escape (`\x00a0`). A test checks this.
- Add a test beside the others, and keep the names in it made up.
