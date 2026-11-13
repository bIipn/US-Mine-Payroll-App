import type {
  Answer,
  ChecklistItem,
  ChecklistSection,
  ChecklistTemplate,
  EquipmentCategory,
  InspectionAnswer,
  InspectionResult,
} from './types';

/**
 * Pre-operational inspection checklists.
 *
 * These are the starting set, written from 30 CFR Part 56 and common practice
 * for surface mobile equipment. They are plain data: to switch to US Mine's own
 * pre-op sheets, replace the sections below (or load them from the backend) —
 * no screen code changes.
 */

const TEMPLATE_VERSION = 1;

const item = (
  id: string,
  label: string,
  hint?: string,
  extra?: { cfr?: string; osha?: string; critical?: boolean },
): ChecklistItem => ({ id, label, hint, ...extra });

const TRACKED: EquipmentCategory[] = ['excavator', 'dozer'];
/** Road-type vehicles: OSHA's motor-vehicle rule (1926.601) is the match. */
const VEHICLES: EquipmentCategory[] = ['water_truck', 'light_vehicle'];

type OshaTopic = 'belt' | 'brakes' | 'horn' | 'backup' | 'glass' | 'general';

/**
 * The OSHA rule that matches an MSHA check, by type of machine:
 * forklifts fall under the powered-industrial-truck standard, road vehicles
 * under the motor-vehicle standard, and the rest under earthmoving equipment.
 */
function oshaFor(category: EquipmentCategory, topic: OshaTopic): string | undefined {
  if (category === 'forklift') return topic === 'glass' ? undefined : '1910.178(q)(7)';
  if (VEHICLES.includes(category)) {
    if (topic === 'backup') return '1926.601(b)(4)';
    if (topic === 'glass') return '1926.601(b)(5)';
    return '1926.601(b)(14)';
  }
  if (topic === 'belt') return '1926.602(a)(2)';
  if (topic === 'brakes') return '1926.602(a)(4)';
  if (topic === 'horn' || topic === 'backup') return '1926.602(a)(9)';
  return undefined;
}

function walkAround(category: EquipmentCategory): ChecklistSection {
  const tracked = TRACKED.includes(category);
  const items: ChecklistItem[] = [
    item('wa_area', 'Area around and under the machine is clear', 'People, tools, rocks, other equipment.'),
    item('wa_leaks', 'No fluid leaks', 'Oil, fuel, coolant or hydraulic fluid on the machine or the ground.', { cfr: '56.4102' }),
    tracked
      ? item('wa_tracks', 'Tracks and undercarriage', 'Pads, rollers, idlers, sprockets and track tension.')
      : item('wa_tires', 'Tires, wheels and lug nuts', 'Cuts, bulges, low pressure, loose or missing lugs.', { osha: oshaFor(category, 'general') }),
    item('wa_access', 'Steps, ladders, handrails and grab irons', 'Secure, not bent, clear of mud and grease.', { cfr: '56.11001' }),
    item('wa_guards', 'Guards, shields and covers in place', 'Fan, belt and driveline guards secure.', { cfr: '56.14107', osha: '1910.212' }),
    item('wa_frame', 'Frame and body', 'No cracks, broken welds or loose parts.'),
  ];
  if (!tracked) {
    items.push(item('wa_chocks', 'Wheel chocks on board', 'Needed any time you park on a grade.', { cfr: '56.14207' }));
  }
  return { id: 'walk', title: 'Walk-around', items };
}

function fluids(category: EquipmentCategory): ChecklistSection {
  const items: ChecklistItem[] = [
    item('fl_oil', 'Engine oil level'),
    item('fl_coolant', 'Coolant level'),
  ];
  if (category !== 'light_vehicle') items.push(item('fl_hyd', 'Hydraulic oil level'));
  items.push(
    item('fl_fuel', 'Fuel and DEF level', 'Enough for the job.'),
    item('en_belts', 'Belts and hoses', 'No cracks, fraying or rubbing.'),
    item('en_battery', 'Battery', 'Secure, terminals tight, cover on.'),
  );
  return { id: 'fluids', title: 'Fluids and engine', items };
}

function cab(category: EquipmentCategory): ChecklistSection {
  const beltCfr = category === 'haul_truck' ? '56.14131' : '56.14130';
  const items: ChecklistItem[] = [
    item('cab_belt', 'Seat belt', 'Latches and retracts; webbing not cut or frayed; mounts tight.', { cfr: beltCfr, osha: oshaFor(category, 'belt'), critical: true }),
  ];
  if (category !== 'light_vehicle') {
    items.push(
      item('cab_rops', 'ROPS / FOPS and cab structure', 'No cracks, dents, added holes or welds.', { cfr: '56.14130', critical: true }),
    );
  }
  items.push(
    item('cab_glass', 'Windows and windshield', 'Clean; no cracks that block your view.', { cfr: '56.14103', osha: oshaFor(category, 'glass') }),
    item('cab_mirrors', 'Mirrors and cameras', 'In place, clean and adjusted.'),
    item('cab_wipers', 'Wipers and washer'),
    item('cab_clean', 'Cab floor and controls clear', 'No loose items, mud or trash around the pedals.', { cfr: '56.14103' }),
    item('cab_gauges', 'Gauges and warning lights', 'Normal readings at start-up; no active alarms.'),
    item('cab_ext', 'Fire extinguisher', 'On board, gauge in the green, pin and seal in place, tag current.', { cfr: '56.4230', osha: '1910.157(e)(2)', critical: true }),
    item('cab_radio', 'Two-way radio', 'Transmits and receives.'),
  );
  return { id: 'cab', title: "Cab and operator's station", items };
}

function functionTests(category: EquipmentCategory): ChecklistSection {
  const tracked = TRACKED.includes(category);
  return {
    id: 'function',
    title: 'Start-up function tests',
    items: [
      item('fn_horn', 'Horn', 'Loud enough to be heard over the plant.', { cfr: '56.14132', osha: oshaFor(category, 'horn'), critical: true }),
      item('fn_backup', tracked ? 'Travel / backup alarm' : 'Backup alarm', 'Sounds as soon as reverse is selected.', { cfr: '56.14132', osha: oshaFor(category, 'backup'), critical: true }),
      item('fn_lights', 'Lights and beacon', 'Head, tail, brake, signal and work lights; strobe.', { osha: VEHICLES.includes(category) ? '1926.601(b)(14)' : undefined }),
      item('fn_brakes', tracked ? 'Brakes' : 'Service brakes', 'Stop and hold the machine.', { cfr: '56.14101', osha: oshaFor(category, 'brakes'), critical: true }),
      item('fn_park', tracked ? 'Parking / swing brake' : 'Parking brake', 'Holds on a grade.', { cfr: '56.14101', osha: oshaFor(category, 'brakes'), critical: true }),
      item('fn_steer', 'Steering', 'Responds right away; no excess play.', { osha: oshaFor(category, 'general'), critical: true }),
      item('fn_controls', 'Controls and safety lockout', 'Levers and joysticks work smoothly; lockout and neutral-start work.', { osha: oshaFor(category, 'general'), critical: true }),
    ],
  };
}

const SPECIFIC: Record<EquipmentCategory, ChecklistSection> = {
  loader: {
    id: 'specific',
    title: 'Loader',
    items: [
      item('ld_bucket', 'Bucket, cutting edge and teeth', 'No cracks, missing teeth or loose bolts.'),
      item('ld_arms', 'Lift arms, pins and bushings'),
      item('ld_cyl', 'Hydraulic cylinders and hoses', 'No leaks or chafing.'),
      item('ld_artic', 'Articulation joint', 'Clear of debris; steering frame lock stowed.'),
    ],
  },
  haul_truck: {
    id: 'specific',
    title: 'Haul truck',
    items: [
      item('ht_bed', 'Dump body, tailgate and hinge pins'),
      item('ht_hoist', 'Hoist cylinders and hoses', 'No leaks; body lowers fully.'),
      item('ht_bodyup', 'Body-up alarm and body prop', 'Indicator works; prop or safety pin on board.'),
      item('ht_susp', 'Suspension and hitch', 'Struts, articulation hitch and pins.'),
      item('ht_retarder', 'Retarder / engine brake'),
      item('ht_flaps', 'Mud flaps and rock ejectors'),
    ],
  },
  excavator: {
    id: 'specific',
    title: 'Excavator',
    items: [
      item('ex_boom', 'Boom, stick and bucket', 'Pins, teeth, cracks.'),
      item('ex_hyd', 'Cylinders, lines and quick coupler', 'No leaks; coupler locked.'),
      item('ex_swing', 'Swing area clear', 'Counterweight swing radius free of people and obstructions.'),
    ],
  },
  dozer: {
    id: 'specific',
    title: 'Dozer',
    items: [
      item('dz_blade', 'Blade, cutting edge and push arms'),
      item('dz_ripper', 'Ripper shank and tip'),
      item('dz_cyl', 'Lift and tilt cylinders and hoses', 'No leaks or chafing.'),
    ],
  },
  grader: {
    id: 'specific',
    title: 'Grader',
    items: [
      item('gr_mold', 'Moldboard, cutting edges and end bits'),
      item('gr_circle', 'Circle, drawbar and side-shift'),
      item('gr_scar', 'Scarifier / ripper'),
      item('gr_artic', 'Articulation and wheel lean'),
    ],
  },
  water_truck: {
    id: 'specific',
    title: 'Water truck',
    items: [
      item('wt_tank', 'Tank, mounts and fill lid', 'No leaks; lid secured.'),
      item('wt_spray', 'Spray heads, valves and cannon'),
      item('wt_pump', 'Pump, PTO and hoses'),
    ],
  },
  skid_steer: {
    id: 'specific',
    title: 'Skid steer',
    items: [
      item('ss_restraint', 'Seat bar and interlocks', 'Controls lock out with the bar raised.', { critical: true }),
      item('ss_coupler', 'Attachment coupler', 'Locked, pins fully engaged.'),
      item('ss_arms', 'Lift arms and lift-arm support'),
      item('ss_bucket', 'Bucket or attachment condition'),
    ],
  },
  forklift: {
    id: 'specific',
    title: 'Forklift / telehandler',
    items: [
      item('fk_forks', 'Forks', 'No cracks or bends; locking pins in.', { osha: '1910.178(q)(7)' }),
      item('fk_mast', 'Mast or boom, chains and carriage', undefined, { osha: '1910.178(q)(7)' }),
      item('fk_guard', 'Overhead guard and load backrest', 'In place, not damaged.', { cfr: '56.14106', osha: '1910.178(q)(7)', critical: true }),
      item('fk_hyd', 'Lift and tilt cylinders', 'No leaks; load does not drift down.', { osha: '1910.178(q)(7)' }),
      item('fk_plate', 'Capacity plate and load chart', 'Legible and in the cab.', { osha: '1910.178(q)(7)' }),
    ],
  },
  light_vehicle: {
    id: 'specific',
    title: 'Light vehicle',
    items: [
      item('lv_flag', 'Buggy whip, flag and beacon', 'Required in the pit and on haul roads.'),
      item('lv_firstaid', 'First-aid kit on board'),
      item('lv_cargo', 'Cargo and tools secured'),
    ],
  },
};

export const CATEGORY_LABEL: Record<EquipmentCategory, string> = {
  loader: 'Loader',
  haul_truck: 'Haul truck',
  excavator: 'Excavator',
  dozer: 'Dozer',
  grader: 'Grader',
  water_truck: 'Water truck',
  skid_steer: 'Skid steer',
  forklift: 'Forklift',
  light_vehicle: 'Light vehicle',
};

export const CATEGORY_ORDER: EquipmentCategory[] = [
  'loader', 'haul_truck', 'excavator', 'dozer', 'grader',
  'water_truck', 'skid_steer', 'forklift', 'light_vehicle',
];

const cache = new Map<EquipmentCategory, ChecklistTemplate>();

export function templateFor(category: EquipmentCategory): ChecklistTemplate {
  const cached = cache.get(category);
  if (cached) return cached;
  const template: ChecklistTemplate = {
    id: `preop_${category}`,
    title: `${CATEGORY_LABEL[category]} pre-operational inspection`,
    version: TEMPLATE_VERSION,
    sections: [walkAround(category), fluids(category), cab(category), functionTests(category), SPECIFIC[category]],
  };
  cache.set(category, template);
  return template;
}

export function templateItems(template: ChecklistTemplate): ChecklistItem[] {
  return template.sections.flatMap((section) => section.items);
}

export function findItem(template: ChecklistTemplate, itemId: string): ChecklistItem | undefined {
  return templateItems(template).find((i) => i.id === itemId);
}

/** A Bad Order on a critical item, or one the operator marked unsafe, takes the unit out of service. */
export function isHazard(template: ChecklistTemplate, answer: InspectionAnswer): boolean {
  if (answer.answer !== 'bo') return false;
  return !!answer.hazard || !!findItem(template, answer.itemId)?.critical;
}

export function inspectionResult(template: ChecklistTemplate, answers: InspectionAnswer[]): InspectionResult {
  const defects = answers.filter((a) => a.answer === 'bo');
  if (defects.length === 0) return 'pass';
  return defects.some((a) => isHazard(template, a)) ? 'bad_order' : 'defect';
}

export function countAnswers(answers: InspectionAnswer[]): Record<Answer, number> {
  const counts: Record<Answer, number> = { ok: 0, bo: 0, na: 0 };
  for (const a of answers) counts[a.answer] += 1;
  return counts;
}

/** Work areas offered on the operating sheet. */
export const WORK_AREAS = ['Pit', 'Plant', 'Stockpiles', 'Haul road', 'Ponds', 'Shop / yard'];
