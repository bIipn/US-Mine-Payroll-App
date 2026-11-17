# MineMuster office dashboard

The office side of MineMuster, for supervisors and the people in the office, served at **https://app.minemuster.com**. The crew keeps using the app on their phones; the phones send their records to the company's server, and this dashboard reads them there.

It is a Vite + React + TypeScript web app. It talks to the MineMuster Supabase project (`supabase/` in this repository) and nothing else, and it works out every figure with the app's own code from `../src`, so the office and the phones always agree.

## What it does

**Signing in.** Email and password, with Supabase Auth. A new account confirms its email first: after creating one, the page says to check for the link and then sign in, the same words whether or not the email already had an account, so the page tells no one which emails do. "Forgot your password?" emails a link that opens a page to choose a new one. The links use the PKCE flow: a link only signs in the browser that asked for it, so a link someone made for their own account signs nobody in here. A link that has run out, was used already or is opened in another browser says so on the sign-in page. Signing out signs out this browser only; the same account on a phone stays signed in. The password goes to Supabase and nowhere else.

**No company yet.** A new account either starts a company or joins one:

- *Start a company*: the company's name, the state whose hours rules it follows (the 50 states and DC), its time zone (this computer's by default), and the person's own name and job title. They become its first supervisor, and the page shows the join code to give the crew (`create_company`).
- *Join with a code*: the code a supervisor gave out and the name as it is on the roster (`join_company`). The page says what the answer means, as `supabase/README.md` lays out: in (open the company), waiting for a supervisor (with the reason, and a button to check again), a name that fits more than one person, turned down, or no company with that code. The person's own requests are listed below.

**Crew.** Someone on the crew who signs in sees their company and a short note that the dashboard is for supervisors, and where their own records are.

**Supervisors.** A dark sidebar with the company and these pages:

| Page | What is on it |
|---|---|
| Overview | A danger from a pre shift exam first, then the red-tagged units (drawn as the tag), Bad Orders not corrected, open conditions and open maintenance requests; today's equipment checklists and pre shift exams; the roster (who is on it, how many have joined, requests waiting, people the phones know who are not on it); when records last arrived, records set aside, request numbers two phones both gave out, and records sent from an account that is not the person's own |
| Roster | The sign-in roster from the `roster` table: add one person or paste a list (`Last, First \| Job title \| supervisor`); behind each person's Change button, change a job title, make them a supervisor or crew (asked once more either way), let go of an account that joined on the wrong row, take them off; put back someone taken off. The signed-in supervisor's row says You, and the last supervisor who can sign in cannot be made crew, let go or taken off. The requests waiting, to let in (on a new row, an open row, or a row taken from the wrong account) or turn down, with or without keeping them out. The join code, with a button to make a new one. The people the phones have sent as employee records who are not on the sign-in roster yet, to put on it one at a time or all at once |
| Checklists and exams | Every equipment checklist and pre shift exam, a day at a time. A checklist opens as that person's Operator Equipment Checklist card for the day; an exam opens as the area's sheet and the conditions page, with what was found and its date fixed. Shown as signed |
| Defects and conditions | Any danger first, as on the overview; units down; every Bad Order on an equipment checklist not corrected yet and every condition from a pre shift exam with no date fixed, each with its request and how many days it has been open (to a tenth, as the safety log counts them); and what was corrected in the last 30 days |
| Maintenance requests | The queue (not completed, in progress, completed, all), each request opening as the paper form with where it came from and its history |
| Time and payroll | Only when the company keeps time. Hours by the company's pay period, or by workweek and month when it has none: straight time, overtime, double time, holiday, PTO and sick, meal flags for review and shifts with no clock-out, with each person's days. The payroll workbook and the hours file for the span shown |
| Exports | The PDF for an MSHA inspector and the safety log for Excel, for today, the last 7 or 30 days, the last 12 months or any days up to 12 months; the payroll workbook and the payroll hours file (totals or one line a day) |
| Billing | Where the company's MineMuster subscription stands, in plain words, and what is charged; the button to start the 14-day free trial (or to start the subscription again once it has ended), and Manage billing, Stripe's billing portal |

**Billing.** MineMuster is $300 a month for the company, the whole crew included. A 14-day free trial takes a card at checkout; Stripe charges it $300 when the trial ends, then each month, until the company cancels. Cancelling stops the next charge, and the dashboard stays open to the end of the period already paid for. The Billing page says all of that, and where the company stands, from the server's `company_billing(p_company_id)` (`supabase/migrations/20261117000500_billing.sql`), which keeps what Stripe's events said:

| The server says | The page says | The other supervisor pages |
|---|---|---|
| `none` | Start your 14-day free trial | The same panel, to start it |
| `trial` | Free trial until the day it ends, and the first charge, $300 on that day; or, cancelled, the day it closes with nothing charged | Open |
| `active` | The next charge and its date; or, cancelled, the day access ends | Open |
| `past_due` | The last charge did not go through: update the card. Stripe is trying it again | Open |
| `comped` | No charge for this company (let in by hand on the server); or, when a subscription started before that is still running, that it is still charged and how to cancel it | Open |
| `ended` | Why it ended, and how to start again: the trial if the company never had one, otherwise the payment link with no trial (`RESTART_LINK`), or Write to us while that link is not set. A second trial started anyway is said to be one, with the day Stripe charges it | The same panel, to start it again |

The rules are in `src/lib/billing.ts`, with tests: which states open the dashboard, the gate on each page, when the records load, the addresses on Stripe and the words for each state. Billing and Sign out always work. The lock is on the server: a supervisor reads the company's records only while it has MineMuster (`supabase/README.md`, What a supervisor reads). The dashboard follows the same answer and does not ask for the records until `company_billing` says the company is in. Only a server that has no `company_billing` at all (PostgREST's `PGRST202`, or `42883`) lets the supervisor in without that answer, and says quietly on Billing that billing is not set up on the server yet: a company is never shut out because the server is behind. A check that fails or takes over 15 seconds is not taken as a yes: each page says billing could not be checked and offers Check again. A check that fails after an answer is known keeps that answer, so a page neither shuts nor opens on one lost request.

"Start your 14-day free trial" is a link, not a call: Stripe's payment link opens in the same tab with the company's id as `client_reference_id` (how the server ties the subscription to the company) and the signed-in email as `prefilled_email`, each percent-encoded. Stripe sends the person back to `/billing?started=…`; the page then asks `company_billing` every 3 seconds for about a minute until Stripe's word has reached the server, offers no second checkout meanwhile, and after the minute says it can take a moment and offers Check again. Once it is in, it says the trial (or the subscription) has started, to put the crew on the Roster page, and that during early access the crew's app is set up with the company: the iPhone and Android apps are not in the App Store or Google Play yet, and the Overview says the same while no records have arrived. A company with more than one subscription running (two supervisors who each finished checkout, say) is told it is charged for each, and to cancel one in Manage billing or write to us. "Manage billing" opens Stripe's billing portal sign-in in a new tab, with the email filled in. The billing state is asked again when the person comes back to the tab, at most every 30 seconds. The card is entered on Stripe's own pages; the dashboard never sees it.

A new company opens on Billing once it is made. "Start free trial" on minemuster.com opens `https://app.minemuster.com/?start=trial`: the dashboard opens on Create an account, keeps the wish in this browser for a week at most (through confirming the email, which may open another tab), and opens on Billing when a company opens for a supervisor. The crew never see billing, and their screen never asks for it.

Assigning, starting and completing a maintenance request, recording a date fixed, correcting a punch and entering paid leave stay in the app, where the rules for who may do them already live. The dashboard shows them as the phones sent them.

## Where the figures come from

The dashboard loads every record of the company from the `records` table, up to a thousand a request, in pages cut on the primary key (kind, then id), which never changes: a record a phone sends again while the pages load keeps its place, so none is skipped, and the reading goes on until a page comes back empty, so a server that caps a request lower still gives every row (`loadRecords` in `src/lib/api.ts`). It shapes them into the `ReportData` the app's own code takes (`shapeRecords` in `src/lib/records.ts`). From there it is the app's code that works out everything:

- Payroll: `computePayroll` with the company's state rules (`rulesFor`), overtime over whole workweeks, the company's pay periods or workweeks and months (`spans`, `payPeriod`).
- The checklist card and the exam sheet: `dailyCards`, `dayClock`, `examFindings`, `openFindings`, the 21 lines of the card and the 20 conditions as printed (`templates`, `areaExam`).
- Files: `payrollReport` and `safetyReport` (Excel), `payrollHoursFile` (CSV), `inspectorReport` (PDF).

A test makes the payroll, both workbooks, the hours file and the PDF from records shaped this way and from the app's own records, and checks they come out the same: the hours file and the PDF byte for byte, the workbooks file by file inside.

A record the phones took off is left out. A record that is not the shape the app writes, checked all the way down (every list, every line of it, every status and priority: `src/lib/validate.ts`), is set aside and counted on the overview, so one bad row never stops a page; any member of a company can send a record, so this matters. Each page is drawn inside its own error boundary as well, so a page that still cannot be drawn says so and the sidebar keeps working.

The company settings are the ones a supervisor's phone sent, as they are: the name, the state and the pay periods the phones figure their hours and name their files by. A state left empty on the phones stays empty here too, so both figure the hours under the federal rules, and the pages say so. Until a supervisor's phone has sent the settings, the company row on the server is used, and Time and payroll and Exports say which workweek and earning codes that means.

A unit is red tagged while its stored status says so or while an open red-tag request names it, the rule the app applies to its own requests: each unit is whichever phone's copy came last, and a phone that never heard of a tag sends its copy as ready.

A person whose records arrived before their employee record is named from the sign-in roster row of the account that sent them, and their hours are never dropped from payroll or the workbook for want of a name; the hours file, which a payroll system imports, leaves them out until their employee record (with its payroll ID) arrives, and the page lists them. Someone with no name anywhere reads "Unknown", as the app prints them. Someone taken off the app's roster is left out of payroll as on the phones, and the page lists them when they have hours in the span.

The server takes a crew member's shift, checklist or exam for anyone in the company, and any member's change to a maintenance request. So every record page says which account sent it, and a record sent from a crew member's account for someone else, or a request completed from an account that is neither a supervisor nor the person it is assigned to, is listed on the overview and marked on its page for a supervisor to look at.

**Never here:** an hourly rate or anyone's pay. The rate stays on the phone it was entered on, and no page, file or test in this folder reads one. The one figure in dollars is MineMuster's own price, on Billing. Standards are cited only where the app cites them, and the app's summaries of them are plain language, not legal advice.

**Time zone.** The app's code counts days, workweeks and pay periods in the local time of the device it runs on. On a phone at the mine that is the mine's. In the office it is this computer's, so when the computer keeps a different clock from the company's time zone, every page says so. Run payroll on a computer set to the company's time zone.

## Run it

Node 22.12 or newer (`engines` in `package.json` says so, and Vercel builds with it).

```bash
cd dashboard
npm install
npm run dev          # http://localhost:5173
npm test             # Vitest: loading the records, their checks and shaping, the overview, payroll, who sent what, ranges, the roster tools, join answers, errors, time zones, billing
npm run typecheck
npm run build        # typecheck, then the static site in dist/
npm run preview      # serve dist/ locally
```

It talks to the MineMuster Supabase project by default. To point a build at another project, copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (and change `connect-src` in `vercel.json`). A publishable key is meant to be in a web page; row level security on the server is what keeps one company's records from another's. A secret key or a service-role key would get past it, so the build stops if `VITE_SUPABASE_PUBLISHABLE_KEY` is one. Git ignores every `.env` file but the example.

Until the server's record store (`records`, `push_records`, `my_companies`) is applied to the project, signing in works and the dashboard says the server is not set up for the records yet.

## How it uses the app's code

`vite.config.ts` and `tsconfig.json` point `@app` at `../src`. Only the app's pure code is used: `src/domain`, `src/util/format.ts`, and the PDF, Excel and CSV writers in `src/services`. It builds from a clean install of this folder alone, which is how Vercel builds it:

- A bare import made by a file in `../src` (`fflate`, for the Excel writer) is resolved from `dashboard/node_modules`, not the app's, which is not installed when only the dashboard is built.
- Every file, `../src` included, is compiled with this folder's `tsconfig.json` (`tsconfig` in `vite.config.ts`). Left to find the nearest one, Vite would read the app's, which extends Expo's, and Expo is not installed here.
- If a file in `../src` ever imports React Native, Expo or anything else that only runs on a phone, the build stops and says which file. `test/sharedCode.test.ts` walks every import the dashboard makes into `../src`, and every import those files make, and fails on the same thing.

The one file from `src/components` is `logoArt.ts`, the outlines of a company's built-in logo, which is data. It is loaded only for a company that uses it.

## Deploy on Vercel

1. In Vercel, add a new project from this repository.
2. Set **Root Directory** to `dashboard`. Leave on "Include files outside the root directory in the Build Step" (on by default): the build reads `../src`.
3. `vercel.json` sets the rest: framework Vite, install `npm ci`, build `npm run build`, output `dist`, every path rewritten to `index.html` so an address such as `/requests/abc` opens the dashboard on that page, long caching for the hashed files in `/assets`, and the security headers: a Content-Security-Policy that lets the page run only its own scripts and styles and talk only to the MineMuster Supabase project, a Permissions-Policy that turns off the camera, microphone and location, Cross-Origin-Opener-Policy, HSTS, and headers that keep the page out of frames. Stripe's checkout and billing portal are opened as pages (a link), never fetched, so the policy names no Stripe address. A build pointed at another project with `VITE_SUPABASE_URL` must name that project in the policy's `connect-src` too, or every call to it is blocked.
4. Under the project's Domains, add `app.minemuster.com`, and add the DNS record Vercel shows for it (a CNAME for `app`) where minemuster.com's DNS is kept.
5. In the Supabase project, under Authentication → URL Configuration, add `https://app.minemuster.com` to the redirect URLs (and as the site URL if the dashboard is where accounts start). The confirmation email and the password-reset email send people back to the address they signed up from, and Supabase only sends them to addresses on that list.

No environment variables are needed for the MineMuster project. Set the two `VITE_` settings in Vercel only to point a deployment at another one.

## Privacy

The repository is public. Every name in the tests is made up, like the app's sample crew; the fixtures are made from the app's own made-up sample data. Keep real names, a mine's location and anything else personal out of this folder, its tests and its screenshots. The browser keeps the Supabase session and, for convenience, which company was open last, and for a week at most that the person came from the website to start a trial; nothing else is stored on the computer.
