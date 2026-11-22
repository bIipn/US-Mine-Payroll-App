# Crew Passcode Sign-in and Supervisor Invites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crew get into the app with the company code, their name and a passcode of 6 or more digits (no email); supervisors reset passcodes, delete crew sign-ins and invite other supervisors by email from the dashboard.

**Architecture:** A crew member is an ordinary Supabase Auth user made by the server (hidden address, derived password). A new `crew-auth` edge function checks the passcode in SQL (keyed digest, lock, rate limit) and hands back an ordinary session. The phone keeps that session (staying signed in), connects as `connectCompany` does today, and opens the person's own app account by itself. Supervisor tools are SQL functions plus a `supervisor-tools` edge function for the Auth admin calls (invite, delete).

**Tech Stack:** Postgres migrations with PGlite db tests, Supabase edge functions in TypeScript (run under Node in tests), the Expo/React Native app (Jest), the Vite/React dashboard (Vitest).

**Spec:** `docs/superpowers/specs/2026-11-22-crew-passcode-sign-in-design.md` (approved). Read it with this plan.

## Global Constraints

- Passcode: digits only, 6 to 12, easy ones refused (one digit repeated, a straight run up or down, a short pattern repeated, a doubled run like `112233`, a mirror, and about 20 of the most common 6-digit passcodes). One rule, the same in TypeScript and in SQL.
- Lock: 5 wrong in a row lock the account for 15 minutes; 10 wrong in a row lock it until a reset. A right passcode clears the count.
- Reset code: 6 digits, good for 30 minutes and 5 tries; works while locked; using it signs the account out everywhere else.
- Invitation: good for 7 days; one open per row; nobody is on the row until they accept with the invited, confirmed email; the inviter gets the same answer whether or not the email has an account.
- Hidden address: `crew-<32 hex>@crew.minemuster.com`. A crew account is one with a `crew_logins` row; nothing is decided from the address.
- Rate limit: 30 crew-auth requests per 10 minutes per address.
- A passcode account never holds a supervisor row. Supervisors use email and password.
- Staying signed in: the app never signs anyone out by itself (time, no signal, an update, a restart).
- Once signed in, everything works with no signal; no screen that records work waits on a network.
- Edge functions: `crew-auth`, and `supervisor-tools` (the spec's `invite-supervisor`; it also deletes crew sign-ins).
- Server code loads only in builds that name a server, behind the folded condition (`src/services/connection.ts`, `RootNavigator`). The public preview stays under 2,097,152 bytes and holds no `crew-auth` code. New crew answers and words go in `src/domain/serverAnswers.ts`, which only server code imports.
- No real person's name, the mine's location or private settings in code, tests, commits or docs. Tests use made-up people (Sam Ortiz, Riley J Quinn, Lee Park) and companies (Test Pit A).
- Never log a name, passcode, code, address, email, token or key; log error codes only.
- Copy is plain and in sentence case; buttons say what happens.
- New migrations only (`supabase/migrations/20261122000100_crew_sign_in.sql`, `20261122000200_supervisor_invitations.sql`); never edit an applied one.
- Before every commit: the privacy scan (`node $SP/e2e/private-scan.js <repo> changed=<dir> base=<dir>`), the session's Co-Authored-By and Claude-Session lines at the end of the message, and a push to `claude/youthful-fermat-611lnz`.
- Nothing live (database, functions, Auth settings, dashboard, website) changes without the owner's OK.

## Review Focus

- The same sign-up sent twice (a double tap, or a retry after the answer was lost), or two sign-ups racing for one name: one account holds the row; the loser's account is deleted and it answers `already_signed_up`; the app then offers Sign in with the passcode just typed. (Task 6: `a sign_up sent twice for one name makes one account`, `a sign_up that loses the name to another sign-up deletes its account`; Task 11: `a lost sign-up answer turns into a sign-in`.)
- A whole crew signing up the same morning: every crew-auth sign-in reaches Supabase Auth from the function, so Auth's own sign-in limit may turn some down. They should answer `busy` (try again in a few minutes) and leave no half-made account. (Task 6: `an Auth refusal for too many sign-ins answers busy, and a sign-up deletes the account it made`; Task 17 checks the live limit.)
- A name typed the way people type it (capitals, extra spaces, no middle initial, the nickname in quotes) finds the person `join_company` would find. An ambiguous name counts no wrong try against anyone. (Task 3 tests.)
- Restarted, offline for days, access token expired: still signed in, records still saved, refreshed when signal returns. (Task 9: `keeps the session through a restart, days with no signal and an expired token`; Task 10: `a restart keeps the person signed in`.)
- A company with the time clock off: after sign-in the person lands on the checklists, not the Clock. The account opens only once the round has read the settings and the roster. (Task 10 and Task 11 tests.)

---

### Task 1: The passcode rule

**Files:**
- Create: `src/domain/passcode.ts`
- Test: `src/domain/__tests__/passcode.test.ts`

**Interfaces:**
- Produces:
  - `PASSCODE_MIN = 6`, `PASSCODE_MAX = 12`, `EASY_PASSCODES: readonly string[]`
  - `type PasscodeProblem = 'not_digits' | 'too_short' | 'too_long' | 'easy'`
  - `passcodeProblem(passcode: string): PasscodeProblem | null`
  - `passcodeWords(problem: PasscodeProblem): string`

- [ ] **Step 1: Write the failing tests**

```ts
describe('passcodeProblem', () => {
  it('takes 6 to 12 digits', () => {
    for (const ok of ['583920', '904712', '27364519', '918273645501']) expect(passcodeProblem(ok)).toBeNull();
  });
  it('refuses letters, spaces and other characters', () => {
    for (const bad of ['58392a', '583 920', '５８３９２０', '-58392']) expect(passcodeProblem(bad)).toBe('not_digits');
  });
  it('refuses fewer than 6 and more than 12 digits', () => {
    expect(passcodeProblem('58392')).toBe('too_short');
    expect(passcodeProblem('5839205839201')).toBe('too_long');
  });
  it('refuses easy patterns', () => {
    for (const easy of ['111111', '000000', '123456', '654321', '234567', '0123456789', '121212', '123123', '112233', '123321', '90099009'])
      expect(passcodeProblem(easy)).toBe('easy');
  });
  it('refuses every passcode on the common list', () => {
    expect(EASY_PASSCODES.length).toBeGreaterThanOrEqual(18);
    for (const easy of EASY_PASSCODES) expect(passcodeProblem(easy)).toBe('easy');
  });
  it('says each problem in plain words that name the fix', () => {
    for (const p of ['not_digits', 'too_short', 'too_long', 'easy'] as const) expect(passcodeWords(p)).toMatch(/digit/);
  });
});
```

- [ ] **Step 2: Run** `npx jest src/domain/__tests__/passcode.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `passcodeProblem` and `passcodeWords` in `src/domain/passcode.ts`.** Digits are ASCII `0-9` only. "Easy" means any of these:
  - every digit the same;
  - each digit one more (or one less) than the last;
  - the whole passcode a 2- or 3-digit block repeated;
  - three or more doubled digits counting up (`112233`);
  - a palindrome;
  - on `EASY_PASSCODES`: the most common 6-digit passcodes from published PIN studies, such as `123456`, `111111`, `000000`, `121212`, `654321`, `666666`, `112233`, `123123`, `159753`, `147258`, `696969`, `520520`, `789456`, `101010`, `102030`, `123654`, `456789`, `987654`.

  Words: "Use only digits.", "Use at least 6 digits.", "Use at most 12 digits.", "That passcode is too easy to guess. Pick 6 digits that are not a pattern."
- [ ] **Step 4: Run** the test and `npm run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** "Passcode rule: 6 to 12 digits, easy ones refused".

---

### Task 2: Server: crew accounts, digests and the lock

**Files:**
- Create: `supabase/migrations/20261122000100_crew_sign_in.sql` (this task writes its first part)
- Test: `supabase/tests/crew_passcodes.db.mjs`

**Interfaces:**
- Consumes: `passcodeProblem` (Task 1), which the test imports under Node to compare against.
- Produces (all `security definer`, `set search_path = pg_catalog, pg_temp`):
  - `public.crew_key (one boolean primary key, key bytea)`, filled by the migration the way `contact_sender_key` is, and `public.crew_logins (user_id uuid primary key references auth.users on delete cascade, salt bytea, digest bytea, wrong_in_a_row int default 0, locked_until timestamptz, reset_digest bytea, reset_until timestamptz, reset_tries int default 0, created_at, passcode_set_at)`. Row level security on, and no API role is granted anything.
  - `public.crew_passcode_problem(passcode text) returns text`, which gives null, `not_digits`, `too_short`, `too_long` or `easy`. No API role.
  - `public.crew_login_password(email text) returns text`: base64 of `sha256(key || 'login:' || lower(email))`. Worked out from the hidden address, not the user id, because the password is needed when the account is made, before it has an id. No API role.
  - `public.crew_keep_passcode(p_user uuid, p_passcode text) returns void`, for service_role only. A problem passcode is refused with 22023, the problem as the hint. Keeping a passcode clears the counts.
  - `public.crew_check_passcode(p_user uuid, p_passcode text) returns jsonb`, internal. It answers `{status:'ok'}`, `{status:'wrong', tries_left}` or `{status:'locked', until}`, where `until` null means until a reset.

- [ ] **Step 1: Write the failing tests:**
  - `no API role can read crew_logins or crew_key`: selects as anon, authenticated and service_role are refused with `42501`.
  - `the server and the app refuse the same passcodes`: for about 300 strings, `crew_passcode_problem` equals `passcodeProblem` from `src/domain/passcode.ts`. The strings are the easy list, every pattern, random 4 to 14 digit strings and some with letters.
  - `keeps a passcode as a salted digest, never as typed`: the stored digest is not the passcode's bytes, and two accounts with one passcode get different digests.
  - `a right passcode clears the count`.
  - `five wrong in a row lock for 15 minutes, even against the right passcode`: after 5 wrong, the right passcode answers `locked`, with `until` about 15 minutes ahead. After `locked_until` is moved into the past (an admin update), the right passcode answers `ok`.
  - `ten wrong in a row lock until a reset`: the answer is `{status:'locked', until:null}`, and it is still locked after moving the clock.
  - `tries left count down from 5, then from 10`.
  - `guesses sent together are each counted`: 5 wrong checks sent with `Promise.all` leave the account locked.
  - `the check takes the account's row lock`: `pg_get_functiondef` of `crew_check_passcode` reads the account's row `for update` before the counts.
- [ ] **Step 2: Run** `cd supabase/tests && node --test crew_passcodes.db.mjs`. Expected: FAIL.
- [ ] **Step 3: Write the migration's first part.** The digest is `sha256(key || salt || convert_to(passcode, 'UTF8'))`. The salt is 16 random bytes taken from two `gen_random_uuid()`s: no pgcrypto, the same style as the contact form.
- [ ] **Step 4: Run** the test and then the whole db suite (`npm test` in `supabase/tests`). Expected: PASS.
- [ ] **Step 5: Commit** "Server: crew passcodes kept as keyed digests, with a lock".

---

### Task 3: Server: sign-up and sign-in checks, the rate limit, the code lookup

**Files:**
- Modify: `supabase/migrations/20261122000100_crew_sign_in.sql` (append)
- Modify: `supabase/tests/anon.db.mjs` (anonymous callers lose `company_by_code`)
- Test: `supabase/tests/crew_sign_in.db.mjs`

**Interfaces:**
- Consumes: Task 2's functions, and the existing `find_on_roster`, `same_name`, `company_by_code` and the join-code normaliser.
- Produces (service_role only). Each function that takes the phone's address `p_address text` counts it first:
  - Table `public.crew_sign_in_tries (sender bytea, at timestamptz default now())`, no API role.
  - `public.crew_lookup(p_code text, p_address text) returns jsonb`, answering `{status:'company', name, state}`, `{status:'no_company'}` or `{status:'busy'}`.
  - `public.crew_sign_up_check(p_code, p_first, p_last, p_passcode, p_address) returns jsonb`. It answers `busy`, `no_company`, `easy_passcode` (with `problem`), `bad_name` (with `message`, from a 22023 name refusal), `already_signed_up` or `use_email`. On success it answers `{status:'ok', company_id, company_name, login_email, login_password}`, and makes nothing.
  - `public.crew_sign_in_check(p_code, p_first, p_last, p_passcode, p_address) returns jsonb`. It answers `busy`, `no_company`, `ambiguous`, `no_account`, `use_email`, `wrong` or `locked`. On success it answers `{status:'ok', company_id, company_name, login_email, login_password, waiting}`, where `waiting` is true when the person was found by a request that waits for a supervisor.
  - `public.crew_confirm_check(p_user uuid, p_passcode text) returns jsonb`, answering `wrong`, `locked`, `no_account`, or `ok` with the login. It is used for deletion's fresh sign-in: the phone keeps no company code, which can be changed, and the roster name can be corrected.
  - `company_by_code` is revoked from anon. Authenticated callers keep it.

- [ ] **Step 1: Write the failing tests:**
  - `looks up a company by its code the forgiving way, and says no company otherwise`, with inputs in the `abcd-2345` style.
  - `counts tries from one address and says busy past 30 in 10 minutes`. Another address is not affected.
  - `a sign-up check refuses an easy passcode, a bad name, a name already signed up and a supervisor's row, making nothing`.
  - `a sign-up check answers ok with a hidden address on crew.minemuster.com and a password worked out from it`: `login_password = crew_login_password(login_email)`, and the address matches `^crew-[0-9a-f]{32}@crew\.minemuster\.com$`.
  - `signs in a person found by name the way joining finds them`: `Riley` finds `Riley J Quinn`; capitals and spaces are ignored; `Buck` finds `Lee "Buck" Park`.
  - `an ambiguous name answers ambiguous and counts no wrong try against anyone`.
  - `finds a person taken off the roster, and one whose request waits for a supervisor (waiting: true)`. The waiting person is found by the exact name on the request.
  - `a person whose row is held by an email account is sent to the email sign-in` (`use_email`).
  - `anonymous callers can no longer look up a company by code; signed-in ones still can`. Update `anon.db.mjs` to match.
- [ ] **Step 2: Run** `node --test crew_sign_in.db.mjs anon.db.mjs`. Expected: FAIL.
- [ ] **Step 3: Append the functions.** To find the person, try these in order:
  1. `find_on_roster` (active rows);
  2. else an inactive row with `same_name` held by a crew account;
  3. else a pending `join_requests` row with the exact typed name whose account is a crew account.

  A row held by an account that is not a crew account, or a supervisor row, answers `use_email`. The sender digest is `sha256(key || address)`. When there is no address, every such request counts against one shared sender.
- [ ] **Step 4: Run** the tests and the whole db suite. Expected: PASS.
- [ ] **Step 5: Commit** "Server: crew sign-up and sign-in checks, a rate limit, and no anonymous code lookups".

---

### Task 4: Server: the supervisor side of passcodes

**Files:**
- Modify: `supabase/migrations/20261122000100_crew_sign_in.sql`. Append, including a `create or replace function public.roster_before_write` that keeps every existing rule.
- Test: `supabase/tests/crew_supervisors.db.mjs`

**Interfaces:**
- Produces:
  - `roster_before_write` also refuses with `PT409`, hint `supervisor_needs_email`, when `new.role = 'supervisor'` and `new.user_id` has a `crew_logins` row.
  - `public.make_passcode_reset_code(p_roster_id uuid) returns text`, for authenticated callers. The caller must be a supervisor of the row's company, and the row held by a crew account. The code is 6 digits, good for 30 minutes and 5 tries, and replaces an older one.
  - `public.crew_reset_check(p_code, p_first, p_last, p_reset_code, p_new_passcode, p_address) returns jsonb`, for service_role. It answers `busy`, `no_company`, `no_account`, `easy_passcode`, `bad_reset_code` (with `tries_left`), `expired`, or `ok` with the login. On `ok` it keeps the new passcode and clears the lock and the reset code.
  - `public.crew_sign_in_to_delete(p_roster_id uuid) returns uuid`, for authenticated callers. The caller must be a supervisor of the row's company, and the row held by a crew account. It returns that account's id.

- [ ] **Step 1: Write the failing tests:**
  - `a passcode account never holds a supervisor row: not by approval, a role change or an insert`. Each path is refused with `PT409` and hint `supervisor_needs_email`.
  - `only a supervisor of the company makes a reset code, and only for a row held by a passcode account`.
  - `a reset code is 6 digits, good for 30 minutes and 5 tries, and sets a new passcode`.
  - `a reset code works while the account is locked, and does not work twice`.
  - `a supervisor gets the account to delete only for a passcode account of their own company`.
- [ ] **Step 2: Run** `node --test crew_supervisors.db.mjs`. Expected: FAIL.
- [ ] **Step 3: Append the functions and the trigger change.** The reset code is kept the way the passcode is (`reset_digest`, salted and keyed).
- [ ] **Step 4: Run** the tests and the whole db suite. Expected: PASS.
- [ ] **Step 5: Commit** "Server: reset codes, crew sign-ins a supervisor may delete, and no passcode supervisors".

---

### Task 5: Server: supervisor invitations and the roster's sign-in states

**Files:**
- Create: `supabase/migrations/20261122000200_supervisor_invitations.sql`
- Modify: `supabase/tests/supabase-stub.mjs` (add `auth.users.email_confirmed_at timestamptz`) and `supabase/tests/harness.mjs` (`newAccount(label, { confirmed = true } = {})` sets it)
- Test: `supabase/tests/supervisor_invitations.db.mjs`

**Interfaces:**
- Produces:
  - Table `public.supervisor_invitations (id uuid pk, company_id, roster_id, email text, invited_by, created_at, expires_at default now() + 7 days, accepted_at, accepted_by, cancelled_at)`, with one open invitation per `roster_id` (a partial unique index). No API role.
  - `public.invite_supervisor(p_roster_id uuid, p_email text) returns jsonb`, for an authenticated supervisor. The row must be active with no email account on it. It cancels the row's open invitation and answers `{invitation_id, email, company_name}`.
  - `public.account_for_email(p_email text) returns uuid`, for service_role only.
  - `public.resend_supervisor_invitation(p_invitation_id uuid) returns jsonb`, for an authenticated supervisor. The invitation must be open. It renews `expires_at` and answers `{email, company_name}`.
  - `public.cancel_supervisor_invitation(p_invitation_id uuid) returns void`, for an authenticated supervisor.
  - `public.my_supervisor_invitations() returns table (id uuid, company_id uuid, company_name text, first_name text, last_name text, expires_at timestamptz)`: the open, unexpired invitations for the caller's confirmed email.
  - `public.accept_supervisor_invitation(p_invitation_id uuid) returns jsonb`, answering `{company_id, company_name}`.
  - `public.roster_sign_ins(p_company_id uuid) returns table (roster_id uuid, sign_in text, locked_until timestamptz, needs_reset boolean, invitation_id uuid, invited_email text, invited_at timestamptz)`, for supervisors only. `sign_in` is `none`, `passcode` or `email`.

- [ ] **Step 1: Write the failing tests:**
  - `only a supervisor of the company invites, onto an active row with no email account`.
  - `one open invitation per row: a new one cancels the old`.
  - `an invitation is accepted only with the invited, confirmed email, before it expires`.
  - `accepting makes the row a supervisor's and puts the account on it; the keep-a-supervisor guard counts nobody before`. While an invitation is open, the last real supervisor's hard delete is still refused.
  - `accepting onto a row held by a passcode account lets that account go, with a released hold`.
  - `an account already on the company's roster cannot accept an invitation to another row there` (`PT409`).
  - `my invitations lists only open, unexpired ones for my confirmed email`.
  - `the roster's sign-ins say none, passcode, email, locked, needs a reset or invited, for supervisors only`.
- [ ] **Step 2: Run** `node --test supervisor_invitations.db.mjs`. Expected: FAIL.
- [ ] **Step 3: Write the migration.** Accepting locks the invitation and then the row (`for update`), and checks every condition. It then:
  1. releases a crew claim as `release_roster_claim` does;
  2. sets `role = 'supervisor'`;
  3. claims the row for the account.

  The claim takes its own update because the write trigger forbids passing a claim straight on, and the role change comes after the release because of Task 4's rule.
- [ ] **Step 4: Run** the tests and the whole db suite. Expected: PASS.
- [ ] **Step 5: Commit** "Server: supervisor invitations that wait to be accepted, and the roster's sign-in states".

---

### Task 6: Edge function `crew-auth`

**Files:**
- Create: `supabase/functions/crew-auth/handler.ts` and `supabase/functions/crew-auth/index.ts` (as `delete-account/index.ts`)
- Test: `supabase/tests/crew_auth.db.mjs`. It uses the stand-ins of `delete_account.db.mjs`, plus:
  - `POST /auth/v1/admin/users`;
  - `POST /auth/v1/token?grant_type=password`, checking the password against `crew_login_password`;
  - `POST /auth/v1/logout?scope=others`;
  - a switch that makes the token stand-in answer 429.

**Interfaces:**
- Consumes: the SQL functions of Tasks 3 and 4; `serverFrom`, `publishableKeyFrom` and `keyHeaders` from `_shared/server.ts`.
- Produces:
  - `makeHandler(deps: { env: Env; fetch; now?; log? }): (request: Request) => Promise<Response>`, with `MAX_BODY_BYTES = 4096` and `CREW_DOMAIN = 'crew.minemuster.com'`.
  - `clientAddress(request: Request): string`: `cf-connecting-ip` when it is there, else the first `x-forwarded-for` entry, else `''`.
  - Request: `POST` JSON `{ action: 'lookup' | 'sign_up' | 'sign_in' | 'reset' | 'confirm', code?, first_name?, last_name?, passcode?, reset_code?, new_passcode? }`. `confirm` carries the current session as `Authorization: Bearer`.
  - Answer `200`:
    - `{ status: 'company', name, state }` for lookup;
    - `{ status: 'signed_in', session: { access_token, refresh_token, expires_at, user_id }, company: { id, name }, waiting: boolean, join?: <join_company answer> }` for every sign-in, with `join` on sign_up only;
    - otherwise `{ status, ... }` with the statuses of Tasks 3 and 4, plus `busy` for an Auth 429.
  - Errors: `400 bad_request`, `403 origin_not_allowed` (any `Origin` header), `405`, `413 too_large`, `500 not_set_up | try_again`.

- [ ] **Step 1: Write the failing tests:**
  - `lookup answers the company for a good code and no_company otherwise`.
  - `sign_up makes a hidden account, keeps the passcode, joins the company and answers a session`. The Auth user's email is on `crew.minemuster.com`, `app_metadata.sign_in` is `passcode`, and `join.status` is `joined`.
  - `sign_up with a name not on the roster answers a session that waits for a supervisor` (`waiting: true`, `join.status` `pending`).
  - `sign_up deletes the account it made when joining is refused`, using a name that only looks like a roster name.
  - `sign_up refuses an easy passcode, a supervisor's row and a name already signed up, making nothing`.
  - `a sign_up sent twice for one name makes one account`: the second answer is `already_signed_up`.
  - `a sign_up that loses the name to another sign-up deletes its account`. The join stand-in first claims the row for another crew account; `join_company` answers `pending` / `already_claimed`; the handler deletes its own account and answers `already_signed_up`.
  - `an Auth refusal for too many sign-ins answers busy, and a sign-up deletes the account it made`.
  - `sign_in answers a session for the right passcode, and tries left for a wrong one`.
  - `an off-the-roster passcode account signs in but reads none of the company's records`.
  - `reset sets the new passcode, signs other sessions out, and answers a session`.
  - `confirm answers a fresh session for the signed-in passcode account`.
  - `refuses a browser origin, a body too large, and anything but POST`.
  - `never logs a name, passcode, code, address or token`.
- [ ] **Step 2: Run** `node --test crew_auth.db.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement the handler.**
  - **sign_up:** check, then admin create (`email_confirm: true`, `app_metadata: {sign_in:'passcode'}`), then `crew_keep_passcode`, then the password grant, then `join_company` with the new user's token.
  - **sign_up cleanup:** an admin delete, with the reason answered, when joining is refused (`no_company`, `denied`, 22023, `ambiguous`), when the join answers `pending` / `already_claimed` (answered as `already_signed_up`), or when any step after the create fails.
  - **sign_in, reset, confirm:** check, then the password grant. Reset then calls `logout?scope=others` with the fresh token. Confirm first reads the bearer's user with `/auth/v1/user`.
  - Every outside call has a 15 second timeout.
- [ ] **Step 4: Run** the tests, `npm test` in `supabase/tests` and `npx tsc -p supabase/functions`. Expected: PASS.
- [ ] **Step 5: Commit** "Edge function crew-auth: sign up, sign in, reset and confirm with a passcode".

---

### Task 7: Edge function `supervisor-tools`

**Files:**
- Create: `supabase/functions/supervisor-tools/handler.ts` and `supabase/functions/supervisor-tools/index.ts`
- Test: `supabase/tests/supervisor_tools.db.mjs` (its stand-ins add `POST /auth/v1/invite`)

**Interfaces:**
- Produces: `makeHandler(deps)` and `ALLOWED_ORIGIN = 'https://app.minemuster.com'`.
  - Request: `POST { action: 'invite', roster_id, email } | { action: 'resend', invitation_id } | { action: 'delete_crew_sign_in', roster_id }`, with the supervisor's bearer token.
  - Answers: `200 { status: 'sent' | 'deleted' }`, `403 not_supervisor`, `409 row_taken | invitation_closed`, plus the error answers of `delete-account`.
  - Invite link: `https://app.minemuster.com/?invited=1`, with `data: { company_name }`.

- [ ] **Step 1: Write the failing tests:**
  - `only the dashboard's origin may call it, with a supervisor's token`.
  - `invite answers sent whether or not the email has an account, and asks Auth to invite only a new email`.
  - `invite refuses a caller who is not a supervisor of the row's company`.
  - `resend sends again only for an open invitation`.
  - `delete_crew_sign_in deletes a passcode account of the caller's company, and nothing else`.
  - `delete_crew_sign_in leaves the row with no account, so the person can sign up for it again`.
- [ ] **Step 2: Run** `node --test supervisor_tools.db.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The caller is read with `/auth/v1/user`.
  - **invite and resend** call their SQL function as the caller, then `account_for_email` with the server key. Only when that is null do they call `POST /auth/v1/invite` with `redirect_to` set to the invite link. They answer `sent` either way. An Auth refusal is logged by its code alone.
  - **delete_crew_sign_in** calls `crew_sign_in_to_delete` as the caller, then the admin `DELETE /auth/v1/admin/users/<id>`.
- [ ] **Step 4: Run** this test, `npm test` in `supabase/tests` and `npx tsc -p supabase/functions`. Expected: PASS.
- [ ] **Step 5: Commit** "Edge function supervisor-tools: invite, send again, delete a crew sign-in".

---

### Task 8: App: reading crew-auth answers, and their words

**Files:**
- Modify: `src/domain/serverAnswers.ts`
- Test: `src/domain/__tests__/crewAnswers.test.ts`

**Interfaces:**
- Consumes: `JoinAnswer` and `readJoinAnswer` (already in `serverAnswers.ts`), and `PasscodeProblem` (Task 1).
- Produces:
  - `type CrewAction = 'lookup' | 'sign_up' | 'sign_in' | 'reset' | 'confirm'`
  - `interface CrewSession { accessToken: string; refreshToken: string; expiresAt: number; userId: string }`
  - `type CrewAnswer`, a union of:
    - `{ kind: 'company'; name: string; state: string }`
    - `{ kind: 'signed_in'; session: CrewSession; company: { id: string; name: string }; waiting: boolean; join: JoinAnswer | null }`
    - `{ kind: 'no_company' | 'already_signed_up' | 'use_email' | 'no_account' | 'ambiguous' | 'expired' | 'busy' | 'unreachable' }`
    - `{ kind: 'wrong'; triesLeft: number }` and `{ kind: 'bad_reset_code'; triesLeft: number }`
    - `{ kind: 'locked'; until: number | null }`
    - `{ kind: 'easy_passcode'; problem: PasscodeProblem }`, `{ kind: 'bad_name'; message: string }` and `{ kind: 'server'; message: string }`
  - `readCrewAnswer(status: number, body: unknown): CrewAnswer`
  - `crewWords(answer: CrewAnswer, now: number): { title: string; body?: string; tone: 'ok' | 'warn' | 'bo' | 'info' }`

- [ ] **Step 1: Write the failing tests.**
  - `readCrewAnswer`: one test for each kind, and a malformed body gives `server`.
  - `crewWords`:
    - `wrong` names the tries left;
    - `locked` gives the time the lock ends, or says to ask a supervisor for a reset code;
    - `already_signed_up` says to sign in or ask a supervisor;
    - `use_email` points to Supervisor? Sign in with email;
    - every title is in sentence case, and none asks crew for an email.
- [ ] **Step 2: Run** `npx jest src/domain/__tests__/crewAnswers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** An unknown status gives `server`, with the HTTP status in the message. `easy_passcode` uses `passcodeWords`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** "App: crew sign-in answers and their words".

---

### Task 9: App: server calls for passcodes, and staying signed in

**Files:**
- Modify: `src/services/server.ts` and `src/services/connection.ts`
- Test: `src/services/__tests__/server.test.ts` and `src/services/__tests__/connection.test.ts`

**Interfaces:**
- Produces:
  - `crewAuth(action: CrewAction, body: Record<string, string>, bearer?: string): Promise<CrewAnswer>`. It POSTs JSON to `${SERVER.url}/functions/v1/crew-auth` with no Origin, and answers `unreachable` when aborted after 30 s.
  - `useCrewSession(session: CrewSession): Promise<Done<{ account: ServerAccount }>>`, through `auth.setSession`.
  - `ServerAccount.kind: 'passcode' | 'email'`, read from `user.app_metadata.sign_in`.
  - `deleteAccountWithPasscode(passcode: string)`, with the same result type as `deleteAccount`.
  - In connection.ts: `deleteMyServerAccount(secret: { password: string } | { passcode: string })`.

- [ ] **Step 1: Write the failing tests:**
  - `crewAuth posts JSON with no Origin and answers unreachable after 30 seconds`.
  - `useCrewSession hands the tokens to the client and reads the account kind`.
  - `deleteAccountWithPasscode confirms the passcode for a fresh session, then calls delete-account`.
  - `keeps the session through a restart, days with no signal and an expired token`. The client is made with `persistSession: true`, `autoRefreshToken: true` and `safeStorage`. A failed refresh while offline keeps the stored session. No code path calls `auth.signOut` except `signOut` and deletion; the test checks this by listing the client calls.
- [ ] **Step 2: Run** `npx jest src/services`. Expected: FAIL.
- [ ] **Step 3: Implement.** `deleteAccountWithPasscode` runs `crewAuth('confirm', { passcode }, <current token>)`, sets that session, then follows the existing `deleteAccount` path.
- [ ] **Step 4: Run** `npx jest src/services` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** "App: passcode sign-in calls and deleting with a passcode".

---

### Task 10: App store: one person per phone, opened by the sign-in

**Files:**
- Modify:
  - `src/domain/types.ts` (`AuthProvider` adds `'company'`);
  - `src/domain/access.ts` (`accountHere`: on a connected phone, only the sign-in's own person);
  - `src/store/useStore.ts`.
- Test: `src/store/__tests__/ownAccount.store.test.ts`, and an update to `src/domain/__tests__/access.test.ts`

**Interfaces:**
- Consumes: `signInIsTheirs` (`src/domain/access.ts`) and `sendable` (`src/domain/accountDeletion.ts`).
- Produces two store actions:
  - `openOwnAccount(): Result`. On a connected phone with nobody signed in, it finds the one active person `signInIsTheirs` says the sign-in is for. It makes or reuses their account `{ provider: 'company', email: '' }`, with no password, and starts the session. It runs by itself after a round has read the settings and the roster (`REFERENCE_KINDS` reads settings first).
  - `forgetPhone(): Result`. It is allowed when the phone's sign-in is the person's own and `sendable(sync) === 0`. It empties the phone as `clearDevice` does. Records the company turned down (`receiving.held`) do not hold it up.

- [ ] **Step 1: Write the failing tests:**
  - `opens the signed-in person's own account once the settings and roster arrive, with no password`.
  - `never opens anyone else's account`.
  - `a company with the time clock off opens on the checklists`.
  - `a restart keeps the person signed in`: rehydrated from storage, the session and `connectedCompany` are kept.
  - `forgetting the phone waits until everything has reached the company, then empties it`.
  - access: `on a connected phone only the sign-in's own person has an account`.
- [ ] **Step 2: Run** `npx jest src/store src/domain/__tests__/access.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** No `STATE_VERSION` change: the saved shape keeps its fields, and `'company'` is only a new provider value. Update the tests that pinned the supervisor-phone case of `accountHere`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** "App: one person per phone, their account opened by their sign-in".

---

### Task 11: App: the company sign-in screen

**Files:**
- Create: `src/screens/auth/CompanySignInScreen.tsx`
- Modify:
  - `src/navigation/RootNavigator.tsx`: load the screen behind the same folded condition as `CompanyAccountScreen`, as the first screen of the `out` group when `CAN_CONNECT`;
  - `src/navigation/types.ts` (`CompanySignIn`);
  - `src/screens/auth/AuthScreen.tsx`: remove `ConnectPanel` and the connecting-build branches, since Auth now shows only in builds with no server.
- Test: `src/screens/__tests__/companySignIn.test.tsx`; updates to `src/navigation/__tests__/viewChange.test.tsx` and `src/components/__tests__/webPages.test.ts` (the new screen carries `<WebPageLinks`)

**Interfaces:**
- Consumes: `crewAuth`, `useCrewSession`, `signIn`, `resetPassword`, `myCompanies`, `myJoinRequests` and `pickCompany`; the store's `connectCompany` and `openOwnAccount`; `passcodeProblem`, `crewWords`, `spacedJoinCode` and `checkJoinCode`.

- [ ] **Step 1: Write the failing tests:**
  - `shows the company's name once a good code is typed, and says no company for a wrong one`.
  - `sign up asks for the passcode twice and refuses an easy one before sending`.
  - `a wrong passcode says how many tries are left; a locked account says until when`.
  - `a lost sign-up answer turns into a sign-in`. After a sign-up the phone sent, `already_signed_up` makes the screen offer Sign in with the passcode it holds.
  - `a request waiting for a supervisor shows the waiting card with Check again`.
  - `someone taken off the roster who signs in is told so, with Delete my account`.
  - `Forgot your passcode? takes the reset code and a new passcode`.
  - `Supervisor? Sign in with email signs in, picks the company and connects`, and its Forgot password? sends the dashboard's reset email.
  - `an email account with no company is told to accept its invitation on the dashboard`.
  - `a company with the time clock off lands on the checklists after sign-in`.
  - navigation: `in a build with a server the first screen is the company sign-in`. Preview builds are unchanged.
- [ ] **Step 2: Run** `npx jest src/screens/__tests__/companySignIn.test.tsx src/navigation`. Expected: FAIL.
- [ ] **Step 3: Implement the screen** from `src/components/ui.tsx`: 56 px targets, `keyboardType="number-pad"` and `secureTextEntry` for passcodes, and words from `crewWords`. When signed in with no active row, a waiting request (`myJoinRequests`) shows the waiting card. Otherwise the off-the-roster card shows.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck` and `npm run build:preview`. Expected: PASS. The file `preview/minemuster-preview.html` is under 2,097,152 bytes, and `grep -c crew-auth preview/minemuster-preview.html` prints 0.
- [ ] **Step 5: Commit** "App: sign in with the company code, your name and a passcode".

---

### Task 12: App: Company account, deleting and signing out

**Files:**
- Modify:
  - `src/screens/more/CompanyAccountScreen.tsx`: remove `SignInForm` and `JoinForm`, and keep the connected view;
  - `src/screens/more/DeleteAccountScreen.tsx`;
  - `src/screens/more/MoreScreen.tsx`;
  - `src/services/connection.ts`;
  - `src/domain/accountDeletion.ts` (wording with no email for passcode accounts).
- Test: updates to `src/screens/__tests__/deleteAccount.test.ts`, `src/domain/__tests__/accountDeletion.test.ts`, `src/services/__tests__/connection.test.ts` and `src/screens/__tests__/authAfterDeletion.test.tsx`

**Interfaces:**
- Produces: `signOutOfPhone(): Promise<{ ok: true } | { ok: false; reason: 'unsent' | 'no_signal'; error: string }>` in connection.ts. It runs a send round and refuses while `sendable(sync) > 0`; otherwise it runs `disconnect()` and then the store's `forgetPhone()`.

- [ ] **Step 1: Write the failing tests:**
  - `a passcode account deletes with its passcode, and is told what stays with the company`.
  - `someone taken off the roster can still delete their account`.
  - `Sign out of this phone is refused while anything is unsent, and says signing back in needs signal`.
  - `a passcode account's hidden address is shown nowhere`: Company account, More and Delete my account show the person's name.
  - Company account no longer shows an email sign-in or a join form.
- [ ] **Step 2: Run** `npx jest src/screens src/services src/domain/__tests__/accountDeletion.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Delete my account:** for a passcode account (`ServerAccount.kind === 'passcode'`), a passcode field with the number pad, calling `deleteMyServerAccount({ passcode })`.
  - **More's Sign out:** in a build with a server, it runs `signOutOfPhone()`. The confirmation says signing back in needs signal, and names any turned-down records that will be dropped. Preview builds keep today's `signOut`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** "App: delete with a passcode, sign out of a phone, simpler Company account".

---

### Task 13: Dashboard: the Roster page's sign-in tools

**Files:**
- Modify:
  - `dashboard/src/lib/api.ts`: `rosterSignIns`, `makeResetCode`, `inviteSupervisor`, `resendInvitation`, `cancelInvitation` and `deleteCrewSignIn`;
  - `dashboard/src/lib/server.ts` (type `RosterSignIn`);
  - `dashboard/src/screens/RosterPage.tsx` (the Account column and the `RowChanges` actions).
- Create: `dashboard/src/lib/signIns.ts`, with `accountWords(signIn: RosterSignIn | undefined, claimedAt: string | null, now: number): string`
- Test: `dashboard/test/signIns.test.ts`, and more cases in `dashboard/test/rosterPage.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `accountWords`: none, passcode, email, locked until a time, needs a reset, and invited.
  - The page shows Reset passcode and Delete sign-in only on passcode rows, Invite only on supervisor rows with no email account, and Send again and Cancel on invited rows.
  - Make a supervisor on a passcode row explains that supervisors sign in with email and opens the invite.
  - The reset code is shown once, with "In the app, tap Forgot your passcode? and type this code with a new passcode."
  - Delete sign-in asks first and says the row and records stay with the company.
- [ ] **Step 2: Run** `cd dashboard && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `rosterSignIns`, `makeResetCode` and `cancelInvitation` call their SQL functions with the dashboard's client.
  - `inviteSupervisor`, `resendInvitation` and `deleteCrewSignIn` call `supervisor-tools` with the session token.
  - The page reloads the sign-ins after each action.
- [ ] **Step 4: Run** `npm test` and `npm run build` in `dashboard`. Expected: PASS.
- [ ] **Step 5: Commit** "Dashboard: reset passcodes, delete crew sign-ins and invite supervisors from the Roster page".

---

### Task 14: Dashboard: arriving from an invitation, and accepting it

**Files:**
- Modify:
  - `dashboard/src/lib/supabase.ts`: `arrivedWith` reads `type=invite` and the tokens from the hash before the client is made;
  - `dashboard/src/App.tsx`: set the session, then show `NewPasswordScreen` worded for an invitation, then the invitations;
  - `dashboard/src/lib/api.ts`: `myInvitations` and `acceptInvitation`;
  - `dashboard/src/screens/EmployeeScreen.tsx`: crew use the app.
- Create: `dashboard/src/screens/InvitationsScreen.tsx`
- Test: `dashboard/test/invitations.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `an invite link is read and tidied from the address`.
  - `after setting a password the invitation shows to accept`.
  - `an account that already existed sees its invitation after signing in`.
  - `accepting re-reads the companies and opens the new one`.
  - The crew page no longer tells crew to use email.
- [ ] **Step 2: Run** `cd dashboard && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** First check whether the PKCE client of supabase-js 2.119 reads an invite hash by itself. If it does not, set the session from the hash, as `arrivedWith` does for the other links.
- [ ] **Step 4: Run** `npm test` and `npm run build` in `dashboard`. Expected: PASS.
- [ ] **Step 5: Commit** "Dashboard: accept an invitation to supervise".

---

### Task 15: Docs, the privacy policy and the deletion page

**Files:**
- Modify:
  - `AGENTS.md`: the server, accounts, deletion, supervisor powers and staying signed in;
  - `README.md`;
  - `supabase/README.md`: the new tables, functions and limits, the two edge functions and their deploy steps;
  - `dashboard/README.md`;
  - `site/privacy.html`: a crew account holds a name and a scrambled passcode, and no email;
  - `site/delete-account.html`: crew delete in the app, even off the roster, or ask a supervisor to delete the sign-in.

- [ ] **Step 1:** Update each file to match the code from Tasks 1 to 14: no email for crew, passcode digests, reset codes, invitations, Delete sign-in, staying signed in, and the rate limit.
- [ ] **Step 2: Run** `npm test` and `cd dashboard && npm test` (wording tests such as `dashboard/test/words.test.ts`). Expected: PASS.
- [ ] **Step 3: Commit** "Docs: crew passcode sign-in, supervisor invites, privacy and deletion".

---

### Task 16: Whole-branch check and review

- [ ] **Step 1: Run everything.** All of these must pass:
  - `npm test` and `npm run typecheck`;
  - `npm test` in `supabase/tests`, and `npx tsc -p supabase/functions`;
  - `npm test` and `npm run build` in `dashboard`;
  - `npm run build:preview` (under 2 MB, no `crew-auth`);
  - the privacy scan over the branch's changed files.
- [ ] **Step 2:** A fresh reviewer reads the whole branch against the spec. Fix each confirmed finding with a test, then run Step 1 again.
- [ ] **Step 3: Commit** the fixes.

---

### Task 17: Live rollout (each step waits for the owner's OK)

- [ ] **Step 1:** Apply `20261122000100` and `20261122000200` to the live database, one transaction each with its `schema_migrations` row. Then check the tables, grants and functions.
- [ ] **Step 2:** Deploy `crew-auth` and `supervisor-tools` with `_shared/server.ts` and JWT verification off. Smoke-test them with requests that sign nobody in. Send lookups with made-up `X-Forwarded-For` values and check, by counting senders in `crew_sign_in_tries` (digests only), that a caller cannot pick their own address. If they can, count by the address the platform adds, and tell the owner that the contact form counts the same way.
- [ ] **Step 3:** Check these Auth settings:
  - Sessions have no time limit or inactivity timeout.
  - The sign-in rate limit is high enough for a crew signing up in one morning, since the function's sign-ins may all count as one address. Raising it is a live setting.
  - `https://app.minemuster.com/?invited=1` is an allowed redirect.
  - Optionally, word the invite email for MineMuster.
- [ ] **Step 4:** Deploy the dashboard, then the website's privacy and deletion pages.
- [ ] **Step 5:** Make a new EAS production build and send it to TestFlight. The owner tries it with a made-up test company, never with a real crew member's name.
