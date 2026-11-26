# Google Play listing

What MineMuster's Google Play listing says, and the answers for Play Console's App content forms. The phone screenshots
here are 1080 × 1920 (9:16; Play takes none longer than 2:1). Each is a real screen of the public sample build, with
its made-up company and crew, under a short headline on MineMuster's dark ground in the app's Barlow fonts: the same
eight screens and headlines as the App Store set. The icon (`../play-icon.png`, 512 × 512) and the feature graphic
(`../play-feature-graphic.png`, 1024 × 500) are made by `scripts/make-brand-assets.py`.

Sign-in details for App Review are typed into Play Console only, never into this repository.

## Store listing

- **App name:** MineMuster
- **Short description (79 of 80):** Time clock, equipment checklists and pre shift exams for mine and quarry crews.
- **Category:** Business
- **Website:** https://minemuster.com
- **Privacy policy:** https://minemuster.com/privacy
- **Countries:** United States only (the hours rules and the safety standards in the app are U.S. ones)
- **Price:** Free

### Full description (1,765 of 4,000)

```text
MineMuster is the crew's time clock and safety paperwork for mines, pits and quarries, on the phone each person already carries.

For the crew
• Clock in at the work site. The app checks the site by GPS at the moment of the punch, and never tracks anyone in the background.
• One tap starts a 30-minute lunch, and it ends by itself. Reminders come before the lunch deadline your state sets.
• Fill in the Operator Equipment Checklist line by line, with the safety standard beside each line. Mark a Bad Order and the unit is tagged out of service.
• Make pre shift exams for each work area: guarding, electrical and safe access, plus the area's conditions.
• Send a maintenance request straight from a Bad Order, and see when the unit is back in service.
• See your hours by pay period, workweek or month, with overtime under your state's rules and an estimate of your gross pay.

For supervisors
• A crew board shows who is working, whose lunch is due and what needs fixing, with dangers first.
• Review time, correct a punch with a reason, and add holiday, PTO and sick hours.
• Assign and close maintenance requests.
• Export payroll hours to Excel or a payroll hours file, and make a PDF of the safety records for an MSHA inspector.

Works with no signal
Everything is saved on the phone the moment it is signed, and sent to your company when the phone has signal again.

Getting started
Your company sets up MineMuster on its office dashboard at app.minemuster.com. Crew members sign in with the company code from their supervisor, their name and a passcode, and stay signed in. Supervisors sign in with email.

Standards text in the app is a plain-language summary, not legal advice. Hours and pay figures are before taxes; the pay stub is the official figure.
```

## App content

### Data safety

- **Does the app collect or share any of the required user data types?** Yes
- **Is all of the user data collected by the app encrypted in transit?** Yes
- **Account creation:** Username and password (crew: their name and a passcode; supervisors: email and password)
- **Account deletion link:** https://minemuster.com/delete-account (also in the app: More, then Delete my account)
- **Deleting some data without deleting the account:** No
- **Shared with third parties:** none. Supabase, Vercel and Stripe run parts of MineMuster for us; that is not sharing.

| Data type | Collected | Required or optional | Processed only in memory | Why |
| --- | --- | --- | --- | --- |
| Location: Precise location | Yes | Optional (a clock-in goes through with location off) | No | App functionality |
| Personal info: Name | Yes | Required | No | App functionality, Account management |
| Personal info: Email address | Yes | Optional (only supervisors sign in with email) | No | App functionality, Account management |
| Personal info: User IDs | Yes | Required | No | App functionality, Account management |
| App activity: Other user-generated content (punches, checklists, exams, requests) | Yes | Required | No | App functionality |

Not collected: the hourly rate a person enters (it never leaves the phone), contacts, photos, files, device IDs,
advertising ID, diagnostics or analytics.

### Content rating (IARC questionnaire)

- **Category:** All other app types (utility, productivity, communication or other)
- Violence, fear, sexuality, gambling, language, controlled substances, crude humor: **No** to every question
- **Users interact or exchange content (chat, voice, images):** No
- **Shares the user's current location with other users:** Yes (supervisors see where each punch was made)
- **Purchases of digital goods:** No
- **Web browser or search engine:** No

### Other declarations

- **Target audience:** 18 and over. Not designed for children.
- **Ads:** No ads
- **Advertising ID:** Not used (the app removes the `AD_ID` permission)
- **App access:** All or some functionality is restricted. Instructions: the made-up Demo Quarry company. Supervisor: on
  the first screen tap "Supervisor? Sign in with email" and use the demo supervisor account. Crew: type the company
  code, tap Sign in, then the demo crew name and passcode. Clocking in works anywhere with location turned off: the
  punch goes through, marked for a supervisor to review.
- **Government app, financial features, health, news, COVID-19:** No
- **Permissions:** location while the app is in use only (no background location), notifications (kept across a
  restart of the phone), vibration, internet and network state. No foreground service.
