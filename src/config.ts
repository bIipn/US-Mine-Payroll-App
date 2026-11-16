import { parseAreaSheets } from './domain/areaExam';
import { parsePersonName, parseRoster, startsWithSamples } from './domain/roster';

/**
 * App-wide configuration.
 *
 * DEMO_MODE keeps every account and record on the device and unlocks the demo
 * tools (simulated GPS, sample crew, time travel). Set EXPO_PUBLIC_DEMO=0 once
 * the cloud backend is connected.
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

export const APP_NAME = 'US Mine Crew';
/** The legal name, the way it is printed on the pay stub. */
export const COMPANY = 'U.S. Mine Corp.';
export const SITE_LABEL = 'Ione, California';
