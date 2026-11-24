import { parseAreaSheets } from './domain/areaExam';
import { companyOrDefault, parseCompany } from './domain/company';
import { parsePersonName, parseRoster, startsWithSamples } from './domain/roster';
import { parseServer, type ServerConfig } from './domain/server';
import { SAMPLE_SITE } from './domain/site';
import type { SiteConfig } from './domain/types';

/**
 * App-wide configuration.
 *
 * DEMO_MODE keeps every account and record on the device and unlocks the demo
 * tools (simulated GPS, sample crew, time travel). A build that connects to the
 * company's server needs EXPO_PUBLIC_DEMO=0: a preview never sends (`CAN_SEND`).
 */
export const DEMO_MODE = process.env.EXPO_PUBLIC_DEMO !== '0';

/**
 * The person this build is made for, as "First Last". They are always on the
 * roster as a supervisor, so they can create an account under their own name
 * and add everyone else.
 *
 * Set EXPO_PUBLIC_ROSTER_OWNER in `.env.local`, which is not committed. A real
 * person's name does not belong in the code: this repository is public.
 */
export const ROSTER_OWNER = parsePersonName(process.env.EXPO_PUBLIC_ROSTER_OWNER);

/**
 * Everyone on the mine's own roster, one person to a line: the name, then the
 * job title, then "supervisor" for a supervisor, with a bar between them.
 *
 *     Ortiz, Sam | Crusher
 *     Quinn, Riley J | Maintenance | supervisor
 *
 * A build made with these has them all on the roster, so each can create an
 * account under their own name. They come with no hours or records: nothing is
 * made up for a real person.
 *
 * Set EXPO_PUBLIC_ROSTER in `.env.local`, which is not committed. Real people's
 * names do not belong in the code: this repository is public.
 */
export const ROSTER = parseRoster(process.env.EXPO_PUBLIC_ROSTER);

/**
 * Whether the preview starts with the made-up sample crew and their sample
 * hours, checklists, exams and requests.
 *
 * A build that names its own roster starts without them: only the mine's own
 * people are on it, and it opens with nothing in it but the fleet and the area
 * sheets, ready to be used. A build that names no roster has them, so there is
 * something to look at.
 *
 * EXPO_PUBLIC_SAMPLE_CREW in `.env.local` decides it either way. "1" keeps the
 * samples beside the real roster, for showing the app with a few weeks of
 * history in it; the made-up people are then marked "Sample". "0" starts a
 * build with none.
 */
export const SAMPLE_CREW = startsWithSamples(process.env.EXPO_PUBLIC_SAMPLE_CREW, ROSTER.length);

/**
 * The mine's own work-area sheets for the pre shift exam: the name of an area,
 * then one line for each line of its sheet, with a blank line before the next
 * area. A build made with these starts with them in place of the made-up
 * samples, and a supervisor can add more in the app.
 *
 * Set EXPO_PUBLIC_AREA_SHEETS in `.env.local`, which is not committed. The
 * sheets list the plant's own equipment, and this repository is public.
 */
export const AREA_SHEETS = parseAreaSheets(process.env.EXPO_PUBLIC_AREA_SHEETS);

/**
 * The company this build is made for, as JSON: its name, the state its hours
 * rules follow, where the crew works, its logo and its pay periods.
 *
 *     {"name": "Example Aggregates Co.", "state": "NV", "place": "Fallon, Nevada",
 *      "pay": {"frequency": "biweekly", "firstDay": "2026-11-01",
 *              "payday": {"daysAfter": 6}, "ifBankClosed": "before"}}
 *
 * A fresh install starts with it, and a supervisor can change it in the app.
 * A build that names none starts with the made-up sample company when it has
 * the sample crew, and with nothing filled in when it does not.
 *
 * Set EXPO_PUBLIC_COMPANY in `.env.local`, which is not committed.
 */
const BUILD_COMPANY = parseCompany(process.env.EXPO_PUBLIC_COMPANY);
if (BUILD_COMPANY.error) console.warn(BUILD_COMPANY.error);
export const STARTING_COMPANY = companyOrDefault(BUILD_COMPANY.company, SAMPLE_CREW);
/**
 * The clock-in site a fresh install starts with: the one the build names with
 * its company, else the made-up sample site for a preview with the sample crew,
 * else none until a supervisor sets the pin on the mine.
 */
export const STARTING_SITE: SiteConfig | null = BUILD_COMPANY.site ?? (SAMPLE_CREW ? SAMPLE_SITE : null);

/**
 * The company server this build sends its records to: a Supabase project's
 * address and its publishable key (one made to be in an app; the server's row
 * level security is what guards the data).
 *
 *     EXPO_PUBLIC_SUPABASE_URL=https://example.supabase.co
 *     EXPO_PUBLIC_SUPABASE_KEY=sb_publishable_...
 *
 * With either one empty the build has no server: nothing about one is loaded
 * or shown, and every record stays on the phone. A preview build, and one that
 * starts with the sample crew, sends nothing even with one (`CAN_SEND`).
 *
 * Set them in `.env.local`, which is not committed.
 */
const BUILD_SERVER = parseServer(process.env.EXPO_PUBLIC_SUPABASE_URL, process.env.EXPO_PUBLIC_SUPABASE_KEY);
if (BUILD_SERVER.error) console.warn(BUILD_SERVER.error);

/**
 * Whether this build may send records to a company server at all. A preview
 * never does: its controls make punches up (the simulated GPS, moving a
 * clock-in back, opening as the owner with no account), and a build that starts
 * with the sample crew or the sample company holds records and settings that
 * are not anyone's. So a build that connects needs EXPO_PUBLIC_DEMO=0, and a
 * roster of its own or EXPO_PUBLIC_SAMPLE_CREW=0.
 */
export const CAN_SEND = !DEMO_MODE && !SAMPLE_CREW;
if (BUILD_SERVER.server && !CAN_SEND) {
  console.warn(
    'A preview build, or one with the sample crew, sends nothing to a company server. Set EXPO_PUBLIC_DEMO=0, and EXPO_PUBLIC_SAMPLE_CREW=0 or a roster, for a build that connects.',
  );
}
export const SERVER: ServerConfig | null = CAN_SEND ? BUILD_SERVER.server : null;

export const APP_NAME = 'MineMuster';

/**
 * MineMuster's own pages the app opens in the phone's browser: the privacy
 * policy, which the stores require a link to inside the app, and where to ask
 * for help. Every build offers them, before anyone has signed in.
 */
export const WEB_PAGES = {
  privacy: 'https://minemuster.com/privacy',
  help: 'https://minemuster.com/contact',
} as const;

/**
 * The office dashboard's Set a new password, which Forgot password? opens in the phone's own browser. The
 * link in the email it sends works only in the browser that asked for it: the dashboard takes no sign-in
 * from an address but an invitation's (dashboard/src/lib/supabase.ts, readArrival). So the phone opens this
 * page rather than asking for the email itself, which would send a link the dashboard turns down.
 */
export const PASSWORD_RESET_PAGE = 'https://app.minemuster.com/?start=reset';
