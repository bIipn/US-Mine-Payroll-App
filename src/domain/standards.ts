/**
 * Safety standards referenced by the checklists and the Bad Order guidance.
 *
 * MSHA: US Mine's Ione operation is a surface non-metal mine, so the governing
 * federal standards are in 30 CFR Part 56 (Safety and Health Standards —
 * Surface Metal and Nonmetal Mines). These are what a mine inspector cites.
 *
 * OSHA: the matching federal OSHA rule (29 CFR 1910 general industry and
 * 29 CFR 1926 construction) is listed beside each MSHA standard as a
 * cross-reference. MSHA has jurisdiction at the mine itself; in California,
 * Cal/OSHA's Mining and Tunneling Unit also inspects surface mines every year
 * under the Title 8 Mine Safety Orders.
 *
 * Every entry is a plain-language summary. It is a field aid, not legal advice.
 */

export type Agency = 'MSHA' | 'OSHA';

export interface Standard {
  agency: Agency;
  cite: string;
  title: string;
  summary: string;
}

const m = (section: string, title: string, summary: string): Standard => ({
  agency: 'MSHA',
  cite: `30 CFR § ${section}`,
  title,
  summary,
});

const o = (section: string, title: string, summary: string): Standard => ({
  agency: 'OSHA',
  cite: `29 CFR § ${section}`,
  title,
  summary,
});

export const STANDARDS: Record<string, Standard> = {
  // ---- MSHA, 30 CFR Part 56 --------------------------------------------------------------
  '56.14100': m(
    '56.14100',
    'Safety defects; examination, correction and records',
    '(a) The operator must inspect self-propelled mobile equipment before it is placed in operation on the shift. ' +
      '(b) Defects that affect safety must be corrected in a timely manner. ' +
      '(c) If a defect makes continued operation hazardous, the equipment must be taken out of service and tagged or parked in a posted area until it is fixed. ' +
      '(d) Safety defects that are not corrected immediately must be reported to, and recorded by, the mine operator, and the record kept until the repair is made.',
  ),
  '56.14101': m(
    '56.14101',
    'Brakes',
    'Service brakes must be able to stop and hold the equipment with its typical load on the steepest grade it travels. Parking brakes, where provided, must hold it on that grade.',
  ),
  '56.14103': m(
    '56.14103',
    "Operators' stations",
    'Cab windows must be safety glass and kept clear enough for safe operation. Damaged windows that block the view must be replaced or removed. The cab must be free of materials that could interfere with safe operation.',
  ),
  '56.14106': m(
    '56.14106',
    'Falling object protection',
    'Forklifts, front-end loaders and dozers need falling-object protective structures where falling objects could be a hazard to the operator.',
  ),
  '56.14107': m(
    '56.14107',
    'Moving machine parts',
    'Gears, sprockets, chains, pulleys, flywheels, couplings, shafts, fan blades and similar moving parts must be guarded so people cannot contact them.',
  ),
  '56.14130': m(
    '56.14130',
    'Roll-over protective structures (ROPS) and seat belts',
    'Loaders, dozers, graders, tractors and similar equipment must have ROPS and seat belts. Seat belts must be worn and kept in working condition, and ROPS must not be damaged or altered.',
  ),
  '56.14131': m(
    '56.14131',
    'Seat belts for haulage trucks',
    'Seat belts must be provided and worn in haulage trucks, kept in working condition, and replaced when needed.',
  ),
  '56.14132': m(
    '56.14132',
    'Horns and backup alarms',
    'Horns and other audible warning devices must work. Equipment with an obstructed view to the rear needs a working backup alarm, or a spotter to signal when it is safe to back up.',
  ),
  '56.14200': m(
    '56.14200',
    'Warnings prior to starting or moving equipment',
    'Before moving mobile equipment, sound a warning that can be heard over surrounding noise, or otherwise warn everyone who could be exposed.',
  ),
  '56.14105': m(
    '56.14105',
    'Procedures during repairs or maintenance',
    'Repairs and maintenance are done only with the power off and the equipment blocked against hazardous motion.',
  ),
  '56.14206': m(
    '56.14206',
    'Securing movable parts',
    'When equipment is unattended or not in use, buckets, blades and dippers are lowered to the ground and other movable parts are secured.',
  ),
  '56.14207': m(
    '56.14207',
    'Parking procedures for unattended equipment',
    'Do not leave mobile equipment unattended unless the controls are in park and the parking brake is set. On a grade, chock the wheels or turn them into a bank.',
  ),
  '56.4102': m(
    '56.4102',
    'Spillage and leakage',
    'Flammable or combustible liquid spills and leaks must be removed promptly or controlled so they do not become a fire hazard.',
  ),
  '56.4230': m(
    '56.4230',
    'Fire extinguishers on self-propelled equipment',
    'A fire extinguisher must be on the equipment whenever a fire or its effects could impede escape from it.',
  ),
  '56.4201': m(
    '56.4201',
    'Inspection of firefighting equipment',
    'Fire extinguishers are checked visually at least once a month to confirm they are fully charged and operable.',
  ),
  '56.11001': m(
    '56.11001',
    'Safe access',
    'A safe means of access must be provided and maintained to every working place, including steps, ladders and handholds on equipment.',
  ),
  '56.9101': m(
    '56.9101',
    'Operating speeds and control of equipment',
    'Operators must keep mobile equipment under control while it is moving, at speeds that suit the road, grade, clearance, visibility and traffic.',
  ),
  '56.18002': m(
    '56.18002',
    'Examination of working places',
    'A competent person examines each working place at least once a shift, before miners begin work there, for conditions that could affect safety or health.',
  ),
  '56.23003': m(
    '56.23003',
    'Safety program for surface mobile equipment',
    'The mine keeps a written safety program for surface mobile equipment that identifies hazards and sets procedures for maintenance and operation.',
  ),

  // ---- OSHA cross-references, 29 CFR 1910 and 1926 ----------------------------------------
  '1926.601(b)(14)': o(
    '1926.601(b)(14)',
    'Motor vehicles — check at the start of each shift',
    'Every vehicle in use is checked at the beginning of each shift: service brakes, parking brake, emergency brakes, tires, horn, steering, coupling devices, seat belts, operating controls and safety devices, plus lights, wipers and fire extinguishers where needed. All defects are corrected before the vehicle is placed in service.',
  ),
  '1926.601(b)(4)': o(
    '1926.601(b)(4)',
    'Motor vehicles — backing with an obstructed view',
    'A vehicle with an obstructed view to the rear is backed up only with a reverse alarm that can be heard over surrounding noise, or with an observer signaling that it is safe.',
  ),
  '1926.601(b)(5)': o(
    '1926.601(b)(5)',
    'Motor vehicles — windshields and wipers',
    'Vehicles with cabs need windshields and powered wipers. Cracked and broken glass is replaced.',
  ),
  '1926.602(a)(2)': o(
    '1926.602(a)(2)',
    'Earthmoving equipment — seat belts',
    'Seat belts are provided on loaders, dozers, graders, off-highway trucks, scrapers and similar earthmoving equipment.',
  ),
  '1926.602(a)(4)': o(
    '1926.602(a)(4)',
    'Earthmoving equipment — brakes',
    'Earthmoving equipment needs a service brake system able to stop and hold the machine fully loaded.',
  ),
  '1926.602(a)(9)': o(
    '1926.602(a)(9)',
    'Earthmoving equipment — horn and reverse alarm',
    'Bidirectional machines need a working horn that can be heard over surrounding noise. Equipment with an obstructed view to the rear is not used in reverse without a working reverse alarm or a signal person.',
  ),
  '1910.178(q)(7)': o(
    '1910.178(q)(7)',
    'Powered industrial trucks — daily examination',
    'Forklifts are examined before being placed in service, at least daily, and are not placed in service if the examination shows any condition that affects safety. Defects are reported and corrected.',
  ),
  '1910.178(p)(1)': o(
    '1910.178(p)(1)',
    'Powered industrial trucks — unsafe trucks',
    'A forklift found to be in need of repair, defective or in any way unsafe is taken out of service until it is restored to safe operating condition.',
  ),
  '1910.157(e)(2)': o(
    '1910.157(e)(2)',
    'Portable fire extinguishers — monthly inspection',
    'Portable fire extinguishers are visually inspected every month.',
  ),
  '1910.147': o(
    '1910.147',
    'Control of hazardous energy (lockout/tagout)',
    'Before servicing or maintenance, machines are shut down, isolated from their energy sources and locked or tagged out so they cannot start up unexpectedly.',
  ),
  '1910.212': o(
    '1910.212',
    'Machine guarding',
    'Machine guarding protects the operator and others from hazards such as rotating parts, in-running nip points and flying chips.',
  ),
};

export function standard(key?: string): Standard | undefined {
  return key ? STANDARDS[key] : undefined;
}

/** "MSHA § 56.14101" / "OSHA § 1926.602(a)(4)" */
export function shortCite(key: string): string {
  const std = STANDARDS[key];
  return std ? `${std.agency} § ${key}` : key;
}

export const JURISDICTION_NOTE =
  'MSHA has jurisdiction at the mine, so the 30 CFR Part 56 standard is the one an inspector cites. ' +
  'The OSHA rule beside it is the matching federal standard, shown for cross-reference. ' +
  "In California, Cal/OSHA's Mining and Tunneling Unit also inspects surface mines each year under the Title 8 Mine Safety Orders.";

export interface GuidanceStep {
  title: string;
  detail: string;
  /** MSHA standard. */
  cfr?: string;
  /** Matching OSHA rule. */
  osha?: string;
}

/** What to do when a defect makes the unit unsafe to run. These are steps, in order. */
export const BAD_ORDER_STEPS: GuidanceStep[] = [
  {
    title: 'Do not operate it',
    detail: 'A defect that makes operation hazardous takes the unit out of service until it is repaired.',
    cfr: '56.14100',
    osha: '1926.601(b)(14)',
  },
  {
    title: 'Tag it out',
    detail: 'Hang a DO NOT OPERATE tag on the controls, or park it in the posted bad-order area, so nobody else starts it.',
    cfr: '56.14100',
  },
  {
    title: 'Park it safe',
    detail: 'Lower the bucket, blade or bed, set the parking brake, and chock the wheels if it sits on a grade.',
    cfr: '56.14207',
  },
  {
    title: 'Tell your supervisor now',
    detail: 'Safety defects that are not fixed right away have to be reported to the mine operator.',
    cfr: '56.14100',
  },
  {
    title: 'Send the maintenance request (MRF)',
    detail: 'The MRF is the written record of the defect. It stays open until the repair is done and the unit is returned to service.',
    cfr: '56.14100',
  },
  {
    title: 'Leave repairs to maintenance',
    detail: 'Repairs are made with the power off and the machine locked out and blocked against motion, by people assigned and trained to do them.',
    cfr: '56.14105',
    osha: '1910.147',
  },
  {
    title: 'Pre-op the replacement unit',
    detail: 'Any other unit you take has to be inspected by you before you put it to work this shift.',
    cfr: '56.14100',
    osha: '1926.601(b)(14)',
  },
];

/** What to do when a defect was found that does not, by itself, make the unit unsafe. */
export const DEFECT_STEPS: GuidanceStep[] = [
  {
    title: 'Send the maintenance request (MRF)',
    detail: 'Every safety defect that is not fixed on the spot gets reported and recorded.',
    cfr: '56.14100',
  },
  {
    title: 'Talk to your supervisor before you run it',
    detail: 'The unit can work only if the defect does not make operation hazardous. Your supervisor makes that call.',
    cfr: '56.14100',
    osha: '1926.601(b)(14)',
  },
  {
    title: 'Keep watching it',
    detail: 'If it gets worse during the shift, stop, tag the unit out and report it.',
    cfr: '56.14100',
  },
];

/** Reminders shown when a unit is cleared to work. */
export const CLEARED_REMINDERS: GuidanceStep[] = [
  { title: 'Seat belt on', detail: 'Buckle up before you move.', cfr: '56.14130', osha: '1926.602(a)(2)' },
  { title: 'Sound the horn', detail: 'Warn people before the machine moves.', cfr: '56.14200', osha: '1926.602(a)(9)' },
  { title: 'Stay in control', detail: 'Match your speed to the road, grade and traffic.', cfr: '56.9101' },
];
