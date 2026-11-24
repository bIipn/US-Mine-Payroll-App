# Crew passcode sign-in and supervisor invites

Status: design, written 2026-11-22. Approach and the two calls below were chosen by the owner.

## Why

The owner tried the first TestFlight build. To get a crew member into the app today takes two screens and
six steps: make a server account with an email and a password, confirm the email, type the company code
and a name, wait for the roster, then make a second, local account with an email and a second password.
That is too much for someone at the pit, and most crew will not want to give an email at all.

The owner wants the app to work the way a crew thinks about it: **type the company's code, then sign up
with your first and last name and a passcode, or sign in with your name and passcode.** (The owner first
said at least 4 digits; after the builder check showed how a 4-digit passcode could be guessed across a
roster, the owner chose **at least 6 digits, with easy ones refused**.) The company's code is the one it gets when it starts on the dashboard (the website's free
trial). U.S. Mine already has one.

Supervisors are different: several of them run the dashboard and billing, and the supervisor in charge
needs a way to give the others access to the dashboard.

## Goals

- A crew member gets from a fresh install to the Clock screen with: company code, first name, last name,
  passcode of 6 or more digits (typed twice on sign-up). No email, ever.
- Each person uses their own phone, signs in once and **stays signed in** (the owner asked for this
  twice). The app never signs anyone out by itself: not after a length of time, not with no signal, not
  after an app update or a restart. A session ends only when the person signs out on More, deletes their
  account, or is taken off the roster (and then, as today, not while they are on the clock). The same
  holds for supervisors in the app and on the dashboard. With no signal the phone keeps working and
  refreshes the session when signal returns.
- A forgotten passcode is fixed by a supervisor from the dashboard, with no email.
- A supervisor invites another supervisor to the dashboard by email from the Roster page; the invitee
  sets a password and is in.
- Supervisors sign in to the app with the same email and password they use on the dashboard.
- Every supervisor keeps seeing billing, as today.

## Already there (no work)

- **The time clock switch.** A company that does not want clock in and clock out turns off **Time clock
  and hours** on the dashboard's Company page (What the crew uses), or on More → Company in the app. The
  app then shows the safety forms alone: equipment checklists, pre shift exams and maintenance requests,
  with no Clock or My hours tab and no payroll, and opens on the checklists (`keepsTime`). Phones take it
  the next time they are open with signal. It is on the live dashboard. The new sign-in must keep landing
  such a company's people on the checklists, not the Clock screen.

## Non-goals

- Signing in with no signal. A person stays signed in; signing in again after signing out needs signal.
- Several people sharing one phone in a connecting build. (Preview builds keep their local accounts.)
- Changing how supervisors sign in on the dashboard, how billing works, or who can see it.
- Changing the join rules themselves (who claims which roster row, requests, holds, bars).

## Anti-goals (a failure even if it works)

- A crew member ever having to see, type or own an email address.
- A passcode account with a supervisor's powers. Supervisor powers stay behind email and password.
- A passcode that can be guessed: wrong tries must be counted and locked on the server, and must hold
  when many guesses arrive at once.
- A passcode stored or logged anywhere readable: not in the database, the function logs, the phone or a
  test fixture.
- Breaking what works today: preview builds, accounts that already sign in with email, offline records,
  account deletion, the join rules.
- Growing the public preview (the 2 MB one-file build): the new sign-in loads only in builds that name a
  server, behind the same folded condition as the Company account screen.

## Approaches (chosen by the owner)

**Crew sign-in.**
- **1A (chosen): MineMuster's server checks the passcode itself.** The phone sends the code, name and
  passcode to a MineMuster server function. The server keeps the passcode scrambled with a secret key,
  counts wrong tries and locks the account, and on a right passcode signs the person in and hands back an
  ordinary session. Behind the scenes each person is an ordinary server account with a hidden address, so
  every existing protection (row level security by `auth.uid()`, the join rules, account deletion's fresh
  sign-in check) works unchanged.
- 1B: Use the passcode as the account's password. Rejected: Supabase Auth needs at least 6 characters, so
  a 4-digit passcode cannot be one, and it has no per-account lockout, so a coworker could keep guessing.

**Supervisors on the dashboard.**
- **2A (chosen): Invite by email from the Roster page.**
- 2B: Today's way (make an account, type the code and name, wait for approval). Rejected as the main way:
  more steps, and easy to get stuck. It stays as a fallback.

**Calls the owner approved.** Supervisors sign in to the app with email and password, not a passcode,
because their account can change punch times and see billing; crew never see an email field. Every
supervisor keeps seeing billing.

**The owner's answers to the builder check.**
- Passcodes: **6 digits or more, and easy ones refused** (over "refuse easy 4-digit ones" and "any 4
  digits").
- Deleting: **a supervisor can delete a crew member's sign-in from the Roster page**, and a person taken
  off the roster can still sign in, only to delete their own.

## How it works today (what this changes)

- Phone (connecting build): Auth → "Connect to your company" → Company account screen: server account by
  email and password (confirmation email) → "Join your company" with code and name (`join_company`) → back
  on Auth, wait for the roster → make a local app account (email, second password, matched to the person
  by name with `receiving.name`). Local and server accounts are tied only by name (`fits` in
  `src/domain/access.ts`). Deleting an account asks for the server password and signs in again with email.
- Server: `roster.user_id` ties a row to an auth user; one row per account per company; `join_company`
  claims an unclaimed **employee** row by name, otherwise leaves a request; a supervisor row is never
  claimed by a typed name. Nothing in SQL reads `auth.users.email`. `company_by_code` is open to anonymous
  callers with no rate limit (the README says one is needed before launch).
- Dashboard: email sign-in only; a second supervisor joins with the code and is approved on the Roster
  page; the Account column shows Joined or Not joined yet from `user_id`/`claimed_at`.

## The design

### 1. Crew accounts on the server

- **A crew account is an ordinary Supabase Auth user** made by the server, never by the person: a hidden
  address (a random local part on a subdomain MineMuster owns that receives no mail, for example
  `crew-<random>@crew.minemuster.com`) and a long password the server works out from a secret key and the
  user's id. Nobody, the person included, ever sees either. Signing in is the ordinary password grant,
  made by the server function, so sessions carry an `amr` password entry exactly as today.
- **The passcode** is 6 to 12 digits, digits only, and **not an easy one**: the server refuses (and the
  app says so before sending) one digit repeated (`111111`), a straight run up or down (`123456`,
  `654321`), a short pattern repeated (`121212`, `123123`, `112233`), a mirror (`123321`), and a short
  list of the most common 6-digit passcodes from published studies (the builder picks the list, about
  twenty). The check is one shared rule, tested on both sides. It is kept only as a digest made with a
  secret key and a per-account salt, in a table no API role can read (like `contact_sender_key` and
  `contact_senders`). The secret key is made in the database by the migration, in a one-row table no API
  role can read, so nobody ever sees it.
- **Wrong tries:** 5 wrong in a row lock the account for 15 minutes; 10 wrong in a row lock it until a
  supervisor gives a reset code. A right passcode clears the count. Counting and locking take the row's
  lock, so guesses sent at once are counted one by one.
- **A passcode account is never a supervisor.** The server refuses a supervisor row held by a passcode
  account (in the roster's write trigger, so every path is covered: `approve_join_request`, a role change,
  an insert). Crew sign-in refuses a name that is a supervisor's row and says supervisors sign in with
  email.
- **Too many tries from one place:** each crew sign-in request is counted against a keyed digest of the
  first `X-Forwarded-For` address, the way `submit_contact_request` counts senders, with a limit per 10
  minutes (the builder picks the numbers; on the order of 30). This is also the rate limit the README
  asks for before launch: the app's code lookup goes through it, and anonymous callers lose
  `company_by_code` (the dashboard calls it signed in).

### 2. The `crew-auth` function

A new edge function, JWT verification off like `delete-account`, for the app only: it refuses a request
that carries a browser `Origin`, caps the body, and logs codes, never names, passcodes or addresses. It
does its checks through new SQL functions callable by the server key only, and talks to Supabase Auth's
admin and token endpoints itself. Actions:

- **lookup** (code) → the company's name and state, or no company. Rate limited.
- **sign_up** (code, first name, last name, passcode):
  1. Check, in SQL: code, passcode shape, rate limit. Refuse without making anything when the name is
     already a row held by a passcode account (`already_signed_up`: sign in, or ask a supervisor for a
     reset code) or is a supervisor's row (`use_email`).
  2. Make the auth user (admin API, address confirmed so no mail is ever sent), store the passcode digest.
  3. Sign in (password grant) and call `join_company` **as the new user**, so every join rule applies
     unchanged: `joined`, `already_member` or a `pending` request.
  4. If `join_company` refuses (no company, denied, a name that only looks like a roster name, an
     ambiguous name with nothing recorded), delete the account it just made and say why.
  5. Answer with the session, the company and the join answer.
- **sign_in** (code, first name, last name, passcode): find the company; find the person with
  `find_on_roster` (the same matching as joining); the row must be held by a passcode account. A person
  whose request still waits for a supervisor is found by the exact name on that request. **A person taken
  off the roster can still sign in**, but only to delete their account: row level security already keeps
  an account without an active row out of the company's records, and the app shows its off-the-roster
  screen. Check the lock and the passcode; answer with a session, or `wrong` (tries left), `locked`
  (until when, or until a reset), `no_account`, `use_email`, `ambiguous` or no company.
- **reset** (code, first name, last name, reset code, new passcode): find the account as for sign_in,
  check the supervisor's reset code, set the new passcode, clear the lock, sign in, and **sign the account
  out everywhere else** (Supabase Auth's sign-out of other sessions, made with the fresh session), so a
  lost or old phone stops working.

### 3. Supervisor tools on the dashboard

- **Account column** on the Roster page, from a new supervisor-only function: Not joined yet; Joined with
  a passcode; Joined with email; Invited, not signed in yet; Locked until (time); Locked, needs a reset.
- **Reset passcode** (a crew row held by a passcode account): makes a 6-digit reset code, good for 30
  minutes and 5 tries, shown once on the dashboard with what to tell the person ("In the app, tap Forgot
  your passcode? and type this code with a new passcode."). It works even while the account is locked.
- **Delete sign-in** (a row held by a passcode account; the owner's answer): deletes that crew sign-in
  for good, with what the person's own deletion keeps (the row and every record stay with the company,
  the link to the account cleared). It ends every session at once, since the server refuses a deleted
  account. This is also the fix when someone signs up under a coworker's name: the supervisor deletes
  that sign-in and the real person signs up again. Done by a dashboard edge function that checks the
  caller is a supervisor of the row's company and the account is a passcode account (which belongs to
  that one company), then uses Supabase Auth's admin delete.
- **Invite to the dashboard** (a supervisor row with no account): the supervisor types an email. A new
  dashboard edge function (dashboard origin only, the supervisor's own token) checks in SQL that the
  caller is a supervisor of that company and the row is active with no email account, and records a
  **pending invitation** (the company, the row, the email, who sent it, good for 7 days). Nobody is put
  on the row until they **accept**:
  - An email with no MineMuster account gets Supabase Auth's invite email (through the existing Resend
    setup) with a link back to the dashboard. The dashboard reads the link, signs them in, asks them to
    set a password (as after a password-reset link), and shows the invitation to accept.
  - An email that already has an account gets no new account: the invitation waits on the dashboard and
    shows the next time that account signs in (the inviter tells them to look).
  - Either way **the inviter gets the same answer** ("Invitation sent to …"), so the dashboard never tells
    whether an email has an account, and a mistyped address makes nobody a supervisor.
  - Accepting checks, in one step, that the invitation is still open and unexpired, the signed-in
    account's confirmed email is the invited one, and the row is still active with no email account;
    then it puts the account on the row. The company-keeps-a-supervisor guard counts nobody until then.
  - The Roster page shows **Invited, waiting to accept**, with **Send again** and **Cancel invitation**.
- **Make a supervisor** on a row held by a passcode account explains that supervisors sign in with email
  and opens the invite. Accepting it, in the same one step, lets go of the passcode account (with today's
  `released` hold, so it cannot take the row back by typing the name), makes the row a supervisor's and
  puts the email account on it.
- The crew page of the dashboard (`EmployeeScreen`) is reworded: crew use the app, not the dashboard.

### 4. The app (builds that name a server)

The first screen becomes the company sign-in. A sketch:

```
        MINE MUSTER
  Company code   [ ABCD 2345 ]
                 Example Aggregates Co. · Nevada
  [ Sign up ]  [ Sign in ]
  First name     [ Sam        ]
  Last name      [ Ortiz      ]
  Passcode       [ ••••••     ]   (6 or more digits)
  Passcode again [ ••••••     ]   (sign up only)
  [         Sign up          ]
  Forgot your passcode?
  Supervisor? Sign in with email
  Privacy policy · Help
```

- The code is checked as it is typed (lookup) and the company's name shown, so a wrong code is caught
  first. The passcode fields use the number pad and are hidden as typed.
- After a sign-up or sign-in: the phone keeps the session, connects to the company (as `connectCompany`
  does today), reads the roster, and opens the person's own app account by itself: no second account and
  no second password. On a pending request it shows that a supervisor will let them in, with Check again.
- **Forgot your passcode?** asks for the reset code from a supervisor and a new passcode (twice).
- **Supervisor? Sign in with email**: email and password (with Forgot password? sending the dashboard's
  reset email); then the person's company, chosen when they are a supervisor of several; then the same
  automatic open. Any account that already signs in with email keeps working this way.
- **One person per phone.** Signing out (More) signs out of the server too, is allowed only once
  everything on the phone has reached the company, clears that person's records from the phone, and says
  that signing back in needs signal.
- **Deleting an account** asks for the passcode again (crew) or the password (supervisors); the passcode
  goes through `sign_in` for a fresh session, then the existing `delete-account` function, unchanged.
- **Gone from connecting builds:** the separate Connect to your company step, the local email-and-password
  account, the Company account screen's sign-in and join forms (it keeps the connected view: records,
  what is sent and received, sign out, delete), and the rules for several accounts on one joined phone
  (`accountHere`'s supervisor-phone case). Preview and demo builds keep their local accounts exactly as
  they are.
- Wording for every answer lives in `src/domain/serverAnswers.ts`, tested, like today's join answers.

### 5. Docs and the privacy policy

AGENTS.md (the server, accounts, deletion and supervisor-powers rules), the app README, `supabase/README.md`
(new tables, functions, limits, the edge functions, deploy steps), `dashboard/README.md`, and the
privacy policy (`site/privacy.html`): a crew account holds a name and a scrambled passcode, and no email.
The deletion page (`site/delete-account.html`) gains a route with no email: crew delete in the app (More
→ Delete my account, which works even after being taken off the roster), or ask a supervisor to delete
the sign-in from the dashboard.

## Known limits (written down, accepted)

- Anyone with the company's code can try to sign up under a name not yet signed up. The supervisors see
  who has joined on the Roster page and fix a wrong one with Delete sign-in. Rotating the code stops
  people who have left.
- A coworker can still try passcodes on one name: 10 wrong tries lock it until a reset, so the chance of
  a guess is about 10 in a million per account with easy passcodes refused. The per-address limit slows
  trying many names. A company-wide slowdown was considered and left out: it would let one person lock
  the whole crew out of signing in.
- Records a deleted account sent stay with the company; a new sign-in for the same person cannot change
  a shift the old account opened (the server ties a record to the account that first sent it), so a
  supervisor closes such a shift with a correction, as today.

## Testing

- Server (PGlite db tests): passcode digests never readable by API roles; easy and short passcodes
  refused; sign-up check answers; lock after 5 and after 10; parallel wrong guesses counted one by one;
  reset codes (expiry, tries); a supervisor row refused to a passcode account on every path; rate limit;
  `company_by_code` no longer open to anonymous callers; the roster account states for supervisors only;
  invitations (only a supervisor makes one, one open per row, expiry, accepted only by the invited
  confirmed email, the guard counting nobody before acceptance, the passcode account let go of on a
  promotion); an off-the-roster passcode account signs in but reads nothing.
- Edge functions under Node with stand-ins for Supabase Auth (admin create, invite, token, delete,
  sign-out of other sessions), as `delete_account.db.mjs` does: every action and answer, the cleanup when
  a join is refused, a reset signing other sessions out, the invite answering the same whether or not the
  email has an account, Delete sign-in only for a supervisor of that company, origin and body rules, no
  secrets in logs.
- App: answer wording, the sign-in screen's states, the automatic open after the roster arrives,
  sign-out rules, deletion with a passcode, and the preview build unchanged (and still under 2 MB).
  **Staying signed in:** a test holds that a kept session survives a restart, a long time with no signal
  and an expired access token, and that nothing but the person's own sign-out, deletion or removal from
  the roster ends it.
- Dashboard: the Account column, Reset passcode, Delete sign-in, Invite, Send again and Cancel, the
  invite landing and accepting an invitation.

## Rollout (each live step waits for the owner's OK)

1. Build and test everything locally; review.
2. Apply the migration to the live database; deploy `crew-auth` and `invite-supervisor`. Check that
   Supabase Auth keeps sessions without a time limit or an inactivity timeout (its default), so nobody
   is signed out by the server.
3. Optionally, word Supabase's invite email for MineMuster (a live Auth setting).
4. Deploy the dashboard.
5. A new EAS build to TestFlight. The owner tries it with a made-up test company (the App Review demo
   company), never with a real crew member's name.

## Left to the builder

The exact rate-limit numbers; how the digests and the derived password are built (keyed SHA-256, as the
server already does, is fine); whether supabase-js's PKCE client reads the invite link by itself or the
dashboard sets the session from it; whether Supabase Auth accepts the hidden address domain (pick another
MineMuster-owned one if not); how a re-sent invite is made; file layout, names and test structure; any
store version bump the saved shape needs; the exact wording, kept plain and in sentence case.
