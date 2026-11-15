# US Mine Crew

Time clock, the equipment checklist, pre shift exams, maintenance requests and payroll hours for a surface mine crew. Expo (React Native) + TypeScript; one codebase for iOS, Android and web. Read `README.md` for what the app does and where the build stands.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. Before writing code that touches an Expo, EAS or React Native API:

1. Read the major version of `expo` in `package.json`.
2. Read the matching versioned docs at `https://docs.expo.dev/versions/v<major>.0.0/`, or the package's own type definitions in `node_modules/<package>/build/*.d.ts` when the network is closed.

## Commands

```bash
npx expo install <package>   # always use instead of npm install for Expo/RN packages (SDK-matched versions)
npm run web                  # dev server in a browser
npm test                     # Jest
npm run typecheck            # tsc --noEmit
npm run build:web            # static export to dist/
npx expo-doctor              # dependency and config health
```

- With no network access to Expo's servers, prefix Expo CLI commands with `EXPO_OFFLINE=1`.
- `npm run typecheck` runs `tsc` with a larger stack on purpose. The per-icon type files in `lucide-react-native` recurse deeply enough to overflow Node's default stack; plain `npx tsc --noEmit` crashes with "Maximum call stack size exceeded".

Run the tests and the typecheck before calling any task done.

## Project conventions

- **Navigation is React Navigation, kept in memory** (`src/navigation/RootNavigator.tsx`), not Expo Router. There is no URL routing, so the web build can run from a single file or inside a frame. Do not add `linking` config or Expo Router without a reason that outweighs that.
- **Rules live in `src/domain/` as pure functions with tests.** Hours, lunch rules, overtime, the GPS boundary, the equipment checklist and its daily card, pre shift exams and standards. Change a rule there and update its test; screens only display results.
- **Hours are hundredths of an hour, as whole numbers** (1225 = 12.25). Convert minutes with `toHundredths` and never add up rounded floats. This matches the crew's paper timesheet method and keeps every screen and export in agreement.
- **Lunch is one tap and ends by itself.** `startedLunch` in `src/domain/time.ts` writes the end of a lunch when it starts: 30 minutes later. Whether someone is at lunch is always worked out from those two times (`lunchEndAt`, `mealStatus`), never from a timer or a background task, so it is right even if the app was closed. Do not add an end-of-lunch punch. Which notifications are waiting is decided by `reminderPlan` (tested) and only handed to the phone in `src/services/reminders.ts`.
- **Pay periods are the 1st to the 15th (paid the 20th) and the 16th to the end of the month (paid the 5th)**, in `src/domain/payPeriod.ts`. A pay date on a weekend or bank holiday moves to the banking day before. Overtime is always figured over whole workweeks and then summed for the days in the range (`computeRange` in `src/domain/payroll.ts`); never compute overtime from a pay period's days alone. Holiday, PTO and sick hours are paid leave: they add to the total and never count toward overtime.
- **The paper forms are the mine's own, and they are data.** The Operator Equipment Checklist is one card for every machine: 21 lines in `src/domain/templates.ts`, in the order and wording they are printed. Do not add, drop, reorder or reword a line; `checklistFor` only picks the standard shown beside a line for the type of machine. The Pre Shift Exam's three columns and 20 conditions are in `src/domain/areaExam.ts`, also as printed. Tests hold both lists to the paper. The legend at the foot of the card (`ANSWER_LEGEND`) is word for word as well, capitals and punctuation included: do not tidy it.
- **Shifts are day, swing and night** (`SHIFTS` in `src/domain/areaExam.ts`), and a pre shift exam is for one of them. `startingShift` picks the shift a form starts on from the time the person clocked in; the hours it goes by are in `shiftAt`, and they are a guess until the mine gives its own. Use them for that starting choice and nothing else: do not work out from them that an exam is due, done or late. Name a shift with `shiftLabel`.
- **Use the paper's words.** "Equipment checklist" (not "pre-op"), "pre shift exam", "maintenance request", "Bad Order", "red tag", "equipment hours".
- **Standards are cited only once checked.** A line cites MSHA with `cfr` and OSHA with `osha`, or a list of `refs`; every key must exist in `STANDARDS` in `src/domain/standards.ts` (tests enforce it). Do not cite a regulation you have not verified against the regulation text. A line with no checked standard carries none.
- **Area sheets are records in the store** (`areaSheets`), changed by a supervisor in the app. A build can name its own in `EXPO_PUBLIC_AREA_SHEETS`; `parseAreaSheets` reads them and `withSheets` adds them at start-up. The repository only holds the made-up `SAMPLE_AREA_SHEETS`, a plant nothing like the mine's. Do not model a sample, a test string or an example on a real sheet, not even by its generic line names; a test compares the samples with `.env.local` wherever that file names sheets.
- **A signed record is not rewritten.** A checklist keeps its answers and an exam keeps the lines and labels it was made on, whatever happens to the sheet afterwards. The date a condition was fixed is added to its exam (`withFix`; the first date stands), and so is the request it was sent on (`withMrf`).
- **What is signed is what the person can see.** A note, a danger mark or an unsafe mark goes on the record only with a Bad Order. One typed and then withdrawn, by changing the line back to OK or N/A, is dropped by the rules (`examRow`, `signedAnswers`), not just hidden by the form. A form is signed once: the store hands back the record already made when the same draft arrives twice, and each form's button runs once.
- **State is one Zustand store** (`src/store/useStore.ts`) saved to device storage. Screens call store actions; they do not write state directly. When the saved shape changes, raise `STATE_VERSION` and add the step to `migratePersisted` in `src/store/migrate.ts`, with a test.
- **Platform splits use file suffixes**: `notifications.native.ts` / `notifications.ts`, `saveFile.native.ts` / `saveFile.ts`. The plain file is the web version and the source of the shared types.
- **Icons are imported one file at a time** through `src/components/icons.ts`. Importing from the `lucide-react-native` root pulls the whole library into the bundle.
- **Fonts are imported one weight at a time** (`@expo-google-fonts/barlow/500Medium`), for the same reason.
- If `ios/` and `android/` do not exist they are generated. Never edit them by hand; configure native behaviour in `app.json` and config plugins.

## Design

- Palette, type and spacing are in `src/theme/theme.ts`. Build screens from `src/components/ui.tsx`; do not hand-roll buttons or inputs.
- A record is shown as the paper it replaces: the day's equipment card (`ChecklistCard`), an exam (`ExamSheet`) and a maintenance request are built from `src/components/Paper.tsx`. Printed words are condensed capitals; what a person wrote in is the ordinary text face.
- The logo is US Mine Corporation's own. Draw it with `Logo` or `LogoPlate` from `src/components/Brand.tsx`, always on white. Do not redraw it, recolour it, stretch it, set it in a font, or edit the generated `src/components/logoArt.ts` by hand.
- Tap targets are at least 56 px. The crew works in gloves and in sunlight: large type, strong contrast, light backgrounds.
- The top of the Clock screen takes the colour of the person's status (off, on, at lunch, overdue). Do not reuse those field colours for decoration.
- Copy is plain and in sentence case. Buttons say what happens ("Clock in", "Send maintenance request"). Errors say what went wrong and what to do next.

## Privacy and safety rules that must hold

- **This repository is public.** Never commit a real person's name, contact details, pay or any other personal detail: not in code, tests, `src/store/seed.ts`, commit messages, screenshots or sample workbooks. The sample crew is made up and stays that way. The person a build is made for is named in `.env.local` (`EXPO_PUBLIC_ROSTER_OWNER`), which git ignores; `withOwner` in `src/domain/roster.ts` puts them on the roster.
- **The mine's own area sheets stay out of the repository too.** They list the plant's equipment. They go in `.env.local` (`EXPO_PUBLIC_AREA_SHEETS`) or are typed into the app, never into code, tests, the sample data or anything in `docs/`. Build what goes into `docs/` with both settings empty (`EXPO_PUBLIC_ROSTER_OWNER= EXPO_PUBLIC_AREA_SHEETS= npm run build:web`).
- Location is read only at the moment of a punch. Never add background location.
- A punch that is turned down is logged; clock-out and lunch start are never blocked by location.
- Punch times are never silently changed. A correction needs a reason and is appended to the shift's edit history.
- A lunch runs the full 30 minutes. It cannot be cut short from the phone, and no location is read when it ends.
- The notice that lunch is over is always sent. The Lunch reminders setting only covers the reminders before the lunch deadline.
- Lunch flags are for review. Nothing is paid or docked automatically.
- Nothing is signed with a line left blank, or with a Bad Order that does not say what is wrong. That holds for the equipment checklist and for the pre shift exam, in the store as well as on the screen.
- A condition found on a pre shift exam stays open until a date fixed is recorded. Only the person who made the exam or a supervisor records one by hand; completing the maintenance request it was sent on records it too.
- A maintenance request is assigned by a supervisor, and worked by a supervisor or the person it is assigned to. It is not completed without remarks. "Completed by" is the person who closes it; a supervisor closing it out for the person it is assigned to may name that person instead, and nobody else.
- A maintenance request points only at what is there: a unit in the fleet, a checklist made on that unit, a Bad Order on an exam that is still open and has no request yet.
- Nothing closes a condition except its own date fixed. The same line found again on a later exam is a record of its own, and marking the line OK later does not close it. The app tells the person; it never closes one for them.
- A danger is shown as a danger wherever its area is: the area list, the area's sheet, the exam form and the Crew board, ahead of anything else that is open.
- A shift with no clock-out counts no hours anywhere until a supervisor sets its end. Payroll, the equipment card and the exports agree on that.
- An hourly rate is entered by the person it belongs to, for their own pay estimate. It is never shown to anyone else and never goes in an export.
- The pay estimate is labelled as an estimate of gross pay. The pay stub is the official figure.
- Standards text in the app is a plain-language summary, labelled as such, not legal advice.
