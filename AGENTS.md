# US Mine Crew

Time clock, pre-op inspections, maintenance requests and payroll hours for a surface mine crew. Expo (React Native) + TypeScript; one codebase for iOS, Android and web. Read `README.md` for what the app does and where the build stands.

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
- **Rules live in `src/domain/` as pure functions with tests.** Hours, lunch rules, overtime, the GPS boundary, checklists and standards. Change a rule there and update its test; screens only display results.
- **Hours are hundredths of an hour, as whole numbers** (1225 = 12.25). Convert minutes with `toHundredths` and never add up rounded floats. This matches the crew's paper timesheet method and keeps every screen and export in agreement.
- **Lunch is one tap and ends by itself.** `startedLunch` in `src/domain/time.ts` writes the end of a lunch when it starts: 30 minutes later. Whether someone is at lunch is always worked out from those two times (`lunchEndAt`, `mealStatus`), never from a timer or a background task, so it is right even if the app was closed. Do not add an end-of-lunch punch. Which notifications are waiting is decided by `reminderPlan` (tested) and only handed to the phone in `src/services/reminders.ts`.
- **Pay periods are the 1st to the 15th (paid the 20th) and the 16th to the end of the month (paid the 5th)**, in `src/domain/payPeriod.ts`. A pay date on a weekend or bank holiday moves to the banking day before. Overtime is always figured over whole workweeks and then summed for the days in the range (`computeRange` in `src/domain/payroll.ts`); never compute overtime from a pay period's days alone. Holiday, PTO and sick hours are paid leave: they add to the total and never count toward overtime.
- **Checklists and standards are data**, in `src/domain/templates.ts` and `src/domain/standards.ts`. A checklist item cites MSHA with `cfr` and OSHA with `osha`; both keys must exist in `STANDARDS` (a test enforces it). Do not cite a regulation you have not verified against the regulation text.
- **State is one Zustand store** (`src/store/useStore.ts`) saved to device storage. Screens call store actions; they do not write state directly. When the saved shape changes, raise `STATE_VERSION` and add the step to `migratePersisted` in `src/store/migrate.ts`, with a test.
- **Platform splits use file suffixes**: `notifications.native.ts` / `notifications.ts`, `saveFile.native.ts` / `saveFile.ts`. The plain file is the web version and the source of the shared types.
- **Icons are imported one file at a time** through `src/components/icons.ts`. Importing from the `lucide-react-native` root pulls the whole library into the bundle.
- **Fonts are imported one weight at a time** (`@expo-google-fonts/barlow/500Medium`), for the same reason.
- If `ios/` and `android/` do not exist they are generated. Never edit them by hand; configure native behaviour in `app.json` and config plugins.

## Design

- Palette, type and spacing are in `src/theme/theme.ts`. Build screens from `src/components/ui.tsx`; do not hand-roll buttons or inputs.
- The logo is US Mine Corporation's own. Draw it with `Logo` or `LogoPlate` from `src/components/Brand.tsx`, always on white. Do not redraw it, recolour it, stretch it, set it in a font, or edit the generated `src/components/logoArt.ts` by hand.
- Tap targets are at least 56 px. The crew works in gloves and in sunlight: large type, strong contrast, light backgrounds.
- The top of the Clock screen takes the colour of the person's status (off, on, at lunch, overdue). Do not reuse those field colours for decoration.
- Copy is plain and in sentence case. Buttons say what happens ("Clock in", "Send maintenance request"). Errors say what went wrong and what to do next.

## Privacy and safety rules that must hold

- Location is read only at the moment of a punch. Never add background location.
- A punch that is turned down is logged; clock-out and lunch start are never blocked by location.
- Punch times are never silently changed. A correction needs a reason and is appended to the shift's edit history.
- A lunch runs the full 30 minutes. It cannot be cut short from the phone, and no location is read when it ends.
- The notice that lunch is over is always sent. The Lunch reminders setting only covers the reminders before the lunch deadline.
- Lunch flags are for review. Nothing is paid or docked automatically.
- An hourly rate is entered by the person it belongs to, for their own pay estimate. It is never shown to anyone else and never goes in an export.
- The pay estimate is labelled as an estimate of gross pay. The pay stub is the official figure.
- Standards text in the app is a plain-language summary, labelled as such, not legal advice.
