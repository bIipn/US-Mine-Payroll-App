import { checkPaySchedule, type PaySchedule } from './payPeriod';

/**
 * The company a crew works for: its name, the state whose hours rules apply,
 * its logo and its pay periods. A supervisor sets it in the app; a build can
 * name it in EXPO_PUBLIC_COMPANY.
 */

/** The logo drawn at the top of the clock screen and on the sign-in screen. */
export type CompanyLogo =
  /** Artwork traced and built into the app. */
  | { art: 'us-mine' }
  /** An image: an https address, or a data URL from an upload. */
  | { uri: string };

export interface Company {
  /** The legal name, the way it is printed on the pay stub. Empty until a supervisor gives it. */
  name: string;
  /** Two-letter postal code of the state the crew works in. Empty until given. */
  state: string;
  /** Where the crew works, for the sign-in screen: "Fallon, Nevada". */
  place?: string;
  /** The mine's MSHA mine ID, seven digits, printed on the records for an inspector. */
  mineId?: string;
  /** None: the top of the clock screen shows its plain colour. */
  logo?: CompanyLogo;
  /** None: hours are shown by the workweek and the month. */
  pay: PaySchedule | null;
}

export const STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

export function stateName(code: string): string {
  return STATES[code] ?? '';
}

/** The made-up company the sample crew works for. Not modelled on any real one. */
export const SAMPLE_COMPANY: Company = {
  name: 'Sample Mining Co.',
  state: 'CA',
  pay: { frequency: 'semimonthly', payday: { dayOfMonth: [20, 5] }, ifBankClosed: 'before' },
};

const ART_KEYS = ['us-mine'] as const;

function readLogo(value: unknown): CompanyLogo | undefined | 'bad' {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return 'bad';
  if ((ART_KEYS as readonly string[]).includes(value)) return { art: value as 'us-mine' };
  if (/^https:\/\/\S+$/.test(value) || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return { uri: value };
  return 'bad';
}

/** An MSHA mine ID as its seven digits, with any dash or spaces taken out. */
export function normalMineId(text: string): string {
  return text.replace(/[\s-]/g, '');
}

/** What is wrong with a company, or undefined when it is whole. */
export function checkCompany(company: Company): string | undefined {
  if (!company.name.trim()) return 'Give the company’s name.';
  if (!STATES[company.state]) return 'Choose the state the crew works in.';
  if (company.mineId && !/^\d{7}$/.test(normalMineId(company.mineId))) return 'An MSHA mine ID is seven digits, like 0400123.';
  if (company.pay) {
    const problem = checkPaySchedule(company.pay);
    if (problem) return problem;
  }
  return undefined;
}

/** The company named in a build setting (JSON), or what is wrong with it. */
export function parseCompany(text: string | null | undefined): { company?: Company; error?: string } {
  if (!text || !text.trim()) return {};
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'EXPO_PUBLIC_COMPANY is not JSON. Write it as {"name": "...", "state": "CA"}.' };
  }
  if (!raw || typeof raw !== 'object') return { error: 'EXPO_PUBLIC_COMPANY must be a JSON object.' };
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) return { error: 'EXPO_PUBLIC_COMPANY has no name.' };
  const state = typeof raw.state === 'string' ? raw.state.trim().toUpperCase() : '';
  if (!STATES[state]) return { error: `EXPO_PUBLIC_COMPANY names no state we know: "${String(raw.state ?? '')}".` };
  const logo = readLogo(raw.logo);
  if (logo === 'bad') return { error: 'EXPO_PUBLIC_COMPANY has a logo that is not an https address, an image data URL or a built-in key.' };
  const pay = (raw.pay ?? null) as PaySchedule | null;
  if (pay !== null) {
    const problem = typeof pay === 'object' && pay.payday && typeof pay.payday === 'object' ? checkPaySchedule(pay) : 'Say how often and when.';
    if (problem) return { error: `EXPO_PUBLIC_COMPANY pay schedule: ${problem}` };
  }
  const company: Company = { name, state, pay };
  if (typeof raw.place === 'string' && raw.place.trim()) company.place = raw.place.trim();
  if (raw.mineId != null && raw.mineId !== '') {
    const id = normalMineId(String(raw.mineId));
    if (!/^\d{7}$/.test(id)) return { error: 'EXPO_PUBLIC_COMPANY has an MSHA mine ID that is not seven digits.' };
    company.mineId = id;
  }
  if (logo) company.logo = logo;
  return { company };
}

/**
 * The company a fresh install starts with: the build's own, else the sample
 * company for a preview with the sample crew, else nothing filled in.
 */
export function companyOrDefault(fromBuild: Company | undefined, samples: boolean): Company {
  if (fromBuild) return fromBuild;
  if (samples) return SAMPLE_COMPANY;
  return { name: '', state: '', pay: null };
}
