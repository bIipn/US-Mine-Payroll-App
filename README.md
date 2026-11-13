# US Mine Crew

Time clock, pre-operational inspections, maintenance requests and payroll hours for the crew at the US Mine Ione plant. One codebase builds the iPhone app, the Android app and a web version.

It replaces the paper time sheet, the pre-op clipboard and the maintenance request form, and it does the hours math so nobody has to.

![Time clock: sign in, GPS check, lunch countdown, and the day worked out as 12.75 − 0.50 = 12.25](docs/gallery-time-clock.png)

![Pre-op checklist with OK, BO and N/A, the Do Not Operate tag, the steps to take, and the maintenance request](docs/gallery-pre-op.png)

![Supervisor screens: crew board, who is on site, time log, corrections, payroll, maintenance requests, roster and the mine boundary](docs/gallery-supervisor.png)

The Excel exports look like this ([payroll sample](docs/samples/US-Mine-Payroll_sample.xlsx), [safety log sample](docs/samples/US-Mine-Safety-Log_sample.xlsx)):

![Payroll summary sheet in Excel: regular, overtime and double time by employee](docs/excel-payroll.png)

## What it does

**For everyone on the crew**

- **Clock in and out with a GPS check.** A punch only goes through from inside the mine boundary. The location is read at the moment of the punch and never in the background.
- **Lunch, handled.** Lunch is unpaid, runs the full 30 minutes, and comes off the day automatically. The app counts down to the end of the fifth hour of work and reminds you 60, 30 and 15 minutes before it, and again when it passes.
- **Hours the way the timesheet does them.** Minutes become hundredths of an hour (15 min = .25, 45 min = .75). 6:15 AM to 7:00 PM with a 30-minute lunch is 12.75 − 0.50 = **12.25**.
- **Pre-op any unit in a couple of minutes.** Big OK / BO / N/A buttons, a checklist for each type of machine, and the MSHA standard (with the matching OSHA rule) behind every safety check.
- **Bad Order guidance.** A safety defect takes the unit out of service, shows the steps to tag it out with the standard for each step, and pre-fills the maintenance request (MRF).
- **Equipment operating sheet.** Who ran which unit, from when to when, with the meter readings and fuel.

**For supervisors, safety and payroll**

- A live board: who is on site, who is close to their lunch deadline, which shifts have no clock-out, which units are tagged out.
- Time corrections with a required reason and a permanent audit trail.
- Payroll by employee for one or two workweeks: regular, overtime and double time, with lunch flags for review.
- Maintenance request queue: open, in progress, completed and returned to service.
- Roster control: only names on the roster can create an account. Paste a whole list at once.
- **Excel exports** for payroll (summary, daily detail, punch log, flags) and safety (pre-ops, Bad Order items, equipment use, MRFs, time on site).

## Where this build stands

This is a working preview. Every flow above runs, on sample data.

| | |
|---|---|
| **Runs today** | Time clock, GPS boundary check, lunch rules and reminders, pre-ops, Bad Order steps, MRFs, operating sheets, payroll math, corrections, roster, Excel export |
| **Sample data** | 14 made-up employees, 14 made-up units and two weeks of history. Nothing in it is a real US Mine record |
| **Kept on the device** | All data lives on the phone or browser it was entered on. Two phones do not see each other's punches yet |
| **Not connected yet** | The shared cloud database and real Apple, Google and Microsoft sign-in. The buttons and the account screens are built; they need the backend behind them |
| **Not yet tried on a phone** | The iPhone and Android bundles build cleanly, and the app has been driven end to end in a browser. It has not been installed on a physical phone yet |

Going live for the whole crew needs the cloud backend first, so a supervisor's phone can see everyone's punches.

## Run it

```bash
npm install
npm run web        # opens in a browser
npm start          # then scan the QR code with Expo Go on a phone
npm test           # 99 unit tests: hours, lunch rules, overtime, GPS, checklists, Excel
npm run typecheck
npm run build:preview   # packs the whole app into one HTML file in preview/ that opens anywhere
```

The sign-in screen has two shortcuts, "Open as an employee" and "Open as a supervisor", that skip account setup. The Clock screen has preview controls for pretending the phone is at the mine or in town, so the GPS check can be shown from anywhere.

## How the hours are figured

1. Punches count to the minute.
2. Time on site becomes a decimal: minutes ÷ 60, rounded to two places.
3. Lunch becomes a decimal the same way and comes off: paid = on site − lunch.
4. Days add up to weeks as whole hundredths, so the app, the timesheet and the Excel export always agree.

Lunch is taken off by the minutes actually punched, so a 30-minute lunch is 0.50 and a 34-minute lunch is 0.57. Paid rest breaks can be logged but are never taken off.

Overtime follows California rules: over 8 hours in a day or 40 straight-time hours in a week is time-and-a-half, over 12 in a day is double time, and the seventh-day rule applies. The lunch deadline follows California Labor Code §512: the first meal starts before the end of the fifth hour. Flags are for a supervisor to review. Nothing is paid or docked automatically.

## The clock-in boundary

The boundary is a circle around the pin at 38.33419° N, 120.94551° W, 1,000 m (0.62 mi) out by default, which is about 776 acres.

The Central Valley Water Board permit for the site (Order R5-2025-0042, June 2025) describes the US Mine Ione Plant as about 1.25 miles south of Ione on roughly 3,570 acres, of which about 402 acres have been mined, built on or reclaimed, all south of town and west of Highway 124. A circle the size of the full 3,570 acres centered on the pin would reach the south side of town, so the default covers the working area and stops about 0.8 miles short of downtown.

Supervisors can change the radius in the app (Crew → Mine boundary). To use the true property outline instead, set `polygon` on the site in `src/domain/site.ts`; the parcel numbers from the permit are listed there.

## Standards

Ione is a surface non-metal mine, so the governing federal standards are MSHA's 30 CFR Part 56. Each safety check also shows the matching federal OSHA rule (29 CFR 1910 / 1926) as a cross-reference. In California, Cal/OSHA's Mining and Tunneling Unit also inspects surface mines under the Title 8 Mine Safety Orders.

The summaries in the app are a field aid in plain language. They are not legal advice.

## Making it yours

| To change | Edit |
|---|---|
| Pre-op checklists | `src/domain/templates.ts` — plain data, one list per type of machine |
| Standards and Bad Order steps | `src/domain/standards.ts` |
| Lunch and overtime rules | `CA_RULES` in `src/domain/time.ts` |
| Boundary | `src/domain/site.ts`, or in the app |
| Sample crew and fleet | `src/store/seed.ts` |
| Colours and type | `src/theme/theme.ts` |

The real roster and fleet can also be entered in the app: Crew → Roster → Add people → Paste a list.

## How the code is laid out

```
App.tsx                 fonts, storage, navigation
src/domain/             the rules, with tests: hours, lunch, overtime, GPS, checklists, standards
src/store/              app state (saved on the device) and the sample data
src/services/           GPS, notifications, Excel writer, reports, file sharing
src/components/         buttons, time card, danger tag, site map
src/screens/            auth, clock, equipment, hours, more, supervisor
```

Built with Expo (React Native) and TypeScript.

## Before the first store release

- Connect the backend and turn off preview mode (`EXPO_PUBLIC_DEMO=0`).
- Set the real app identifiers in `app.json` (`ios.bundleIdentifier`, `android.package`). They are placeholders now and cannot be changed after the first release.
- Apple Developer Program and Google Play Console accounts in the company's name.
- A privacy policy that covers the location check.
