import { parseAreaSheets } from './domain/areaExam';
import { parsePersonName, parseRoster } from './domain/roster';

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
 * account under their own name. They come with no hours or records: the sample
 * history stays on the made-up sample crew.
 *
 * Set EXPO_PUBLIC_ROSTER in `.env.local`, which is not committed. Real people's
 * names do not belong in the code: this repository is public.
 */
export const ROSTER = parseRoster(process.env.EXPO_PUBLIC_ROSTER);

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
