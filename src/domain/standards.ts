/**
 * Safety standards referenced by the checklists and the Bad Order guidance.
 *
 * MSHA: the app's forms are for surface metal and nonmetal mines, so the
 * governing federal standards are in 30 CFR Part 56 (Safety and Health Standards —
 * Surface Metal and Nonmetal Mines). These are what a mine inspector cites.
 * Two of the conditions on the work-area exam fall under other parts of
 * 30 CFR: hazard communication (Part 47) and noise (Part 62).
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
    '(a) A competent person designated by the operator examines each working place at least once each shift, before miners begin work there, for conditions that may adversely affect safety or health. ' +
      'The operator promptly tells the miners in any affected area about such a condition and promptly starts correcting it. ' +
      'A condition that may be an imminent danger is brought to the operator at once, and the operator withdraws everyone from the affected area, apart from those needed to correct it, until the danger is gone. ' +
      '(b) A record is made before the end of the shift: who made the examination, the date, the areas examined, and each condition found. ' +
      '(c) When a condition is corrected, the date is added to the record. ' +
      "(d) The records are kept for at least one year and shown to MSHA and to the miners' representatives on request.",
  ),
  '56.9300': m(
    '56.9300',
    'Berms or guardrails',
    'Berms or guardrails are provided and kept up on the banks of roadways where a drop-off is steep or deep enough to overturn a vehicle or endanger the people in it. ' +
      'They are at least as high as the mid-axle of the largest equipment that usually uses the road.',
  ),
  '56.9313': m(
    '56.9313',
    'Roadway maintenance',
    'Water, debris or spilled material on a roadway that creates a hazard to mobile equipment is removed.',
  ),
  '56.11002': m(
    '56.11002',
    'Handrails and toeboards',
    'Crossovers, elevated walkways, elevated ramps and stairways are of substantial construction, have handrails and are kept in good condition. Toeboards are provided where they are needed.',
  ),
  '56.11003': m(
    '56.11003',
    'Construction and maintenance of ladders',
    'Ladders are of substantial construction and kept in good condition.',
  ),
  '56.14109': m(
    '56.14109',
    'Unguarded conveyors with adjacent travelways',
    'An unguarded conveyor beside a travelway has emergency stop devices placed so that a person falling on or against the conveyor can readily shut off its drive motor, or railings that keep people from falling onto it.',
  ),
  '56.12004': m(
    '56.12004',
    'Electrical conductors',
    'Conductors are large enough to carry their load without the heat damaging the insulation. Conductors exposed to mechanical damage are protected.',
  ),
  '56.12016': m(
    '56.12016',
    'Work on electrically powered equipment',
    'Electrically powered equipment is de-energized before mechanical work is done on it. The power switch is locked out, or other steps are taken so it cannot be energized without the knowledge of the people working on it, ' +
      'and a warning notice signed by them is posted at the switch. Only the people who put the locks on, or authorized personnel, take them off.',
  ),
  '56.12032': m(
    '56.12032',
    'Inspection and cover plates',
    'Inspection and cover plates on electrical equipment and junction boxes are kept in place at all times, except during testing or repairs.',
  ),
  '56.15001': m(
    '56.15001',
    'First-aid materials',
    'Adequate first-aid materials, including stretchers and blankets, are kept at places convenient to all working areas. Water or neutralizing agents are on hand where corrosive chemicals or other harmful substances are stored, handled or used.',
  ),
  '56.17001': m(
    '56.17001',
    'Illumination of surface working areas',
    'There is enough light for safe working conditions in and on all surface structures, paths, walkways, stairways, switch panels, loading and dumping sites, and work areas.',
  ),
  '56.20003': m(
    '56.20003',
    'Housekeeping',
    'Workplaces, passageways, storerooms and service rooms are kept clean and orderly. Floors are kept clean and, as far as possible, dry, and free of protruding nails, splinters, holes and loose boards as far as practicable.',
  ),
  '56.20011': m(
    '56.20011',
    'Barricades and warning signs',
    'Areas where a health or safety hazard is not immediately obvious to employees are barricaded, or warning signs are posted at every approach. The signs are easy to see and read, and say what the hazard is and what protective action is required.',
  ),
  '47.41': m(
    '47.41',
    'Requirement for container labels',
    'Every container of a hazardous chemical has a label. A label that is missing, or whose hazard information cannot be read, is replaced immediately.',
  ),
  '62.160': m(
    '62.160',
    'Hearing protectors',
    'The mine provides hearing protectors, at no cost, to miners whose noise exposure reaches the action level, and makes sure they are worn where the noise is above the permissible exposure level.',
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

/** Who inspects the mine, for the standards screens. A mine in California is also inspected by Cal/OSHA. */
export function jurisdictionNote(state: string): string {
  const federal =
    'MSHA has jurisdiction at the mine, so the 30 CFR Part 56 standard is the one an inspector cites. ' +
    'The OSHA rule beside it is the matching federal standard, shown for cross-reference.';
  return state === 'CA'
    ? `${federal} In California, Cal/OSHA's Mining and Tunneling Unit also inspects surface mines each year under the Title 8 Mine Safety Orders.`
    : federal;
}

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
    title: 'Red tag it',
    detail: 'Hang a red DO NOT OPERATE tag on the controls, or park it in the posted bad-order area, so nobody else starts it.',
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
    title: 'Send the maintenance request',
    detail: 'The request is the written record of the defect. It stays open until the repair is done and the unit is returned to service.',
    cfr: '56.14100',
  },
  {
    title: 'Leave repairs to maintenance',
    detail: 'Repairs are made with the power off and the machine locked out and blocked against motion, by people assigned and trained to do them.',
    cfr: '56.14105',
    osha: '1910.147',
  },
  {
    title: 'Check the replacement unit',
    detail: 'Any other unit you take gets its own column on your card. You inspect it before you put it to work this shift.',
    cfr: '56.14100',
    osha: '1926.601(b)(14)',
  },
];

/** What to do when a defect was found that does not, by itself, make the unit unsafe. */
export const DEFECT_STEPS: GuidanceStep[] = [
  {
    title: 'Send the maintenance request',
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

/** What to do when a pre shift exam finds a condition that could hurt someone right now. */
export const AREA_DANGER_STEPS: GuidanceStep[] = [
  {
    title: 'Get everyone out of the area',
    detail: 'People stay out until the danger is gone, apart from those needed to fix it.',
    cfr: '56.18002',
  },
  {
    title: 'Tell your supervisor now',
    detail: 'A condition that may be an imminent danger has to reach the operator at once.',
    cfr: '56.18002',
  },
  {
    title: 'Barricade it or post a warning',
    detail: 'Block every way in, or post a sign that says what the hazard is, so nobody walks into it.',
    cfr: '56.20011',
  },
  {
    title: 'Get it fixed',
    detail: 'Send the maintenance request from this exam so the repair is tied to what you found.',
    cfr: '56.18002',
  },
  {
    title: 'Record the date it was fixed',
    detail: 'The date goes on this exam. Until then the condition stays on the list for the area.',
    cfr: '56.18002',
  },
];

/** What to do when a pre shift exam finds a condition to correct. */
export const AREA_CONDITION_STEPS: GuidanceStep[] = [
  {
    title: 'Tell the people who work in the area',
    detail: 'Everyone affected has to know promptly about a condition that could hurt them.',
    cfr: '56.18002',
  },
  {
    title: 'Get it fixed',
    detail: 'Put it right yourself if you can do it safely. Otherwise send the maintenance request from this exam.',
    cfr: '56.18002',
  },
  {
    title: 'Record the date it was fixed',
    detail: 'The date goes on this exam. Until then the condition stays on the list for the area.',
    cfr: '56.18002',
  },
];

/** Reminders shown when a unit is cleared to work. */
export const CLEARED_REMINDERS: GuidanceStep[] = [
  { title: 'Seat belt on', detail: 'Buckle up before you move.', cfr: '56.14130', osha: '1926.602(a)(2)' },
  { title: 'Sound the horn', detail: 'Warn people before the machine moves.', cfr: '56.14200', osha: '1926.602(a)(9)' },
  { title: 'Stay in control', detail: 'Match your speed to the road, grade and traffic.', cfr: '56.9101' },
];
