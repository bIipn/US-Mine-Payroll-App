import { cleanText } from './roster';
import type {
  Answer,
  ChecklistItem,
  ChecklistTemplate,
  EquipmentCategory,
  InspectionAnswer,
  InspectionResult,
} from './types';

/**
 * The Operator Equipment Checklist.
 *
 * This is the mine's own card, and it is the same for every piece of
 * equipment: the 21 lines below are in the order they are printed, in the
 * card's wording. A line that does not apply to a machine is marked N/A.
 *
 * The one thing that depends on the type of machine is which standard sits
 * behind a line. `checklistFor` fills that in.
 */

const CHECKLIST_VERSION = 1;
/** The id on every checklist made on the card's 21 lines. */
export const CHECKLIST_ID = 'operator_equipment_checklist';

/**
 * Whether a checklist was made on the card's lines. One signed before the card
 * was built in keeps its own answers, which are not the 21 lines, so it is
 * shown as an earlier checklist and never laid over the card's boxes.
 */
export const onTheCard = (inspection: { templateId: string }): boolean => inspection.templateId === CHECKLIST_ID;

/** What a card or an export says in place of the boxes of an earlier checklist. */
export const EARLIER_CHECKLIST = 'Made on the checklist used before this card, so its lines are not the ones printed here';

/** The line that also takes the gallons of fuel added. */
export const FUEL_LINE = 'fuel';

type Line = Omit<ChecklistItem, 'cfr' | 'osha'>;

const LINES: Line[] = [
  { id: 'fire_extinguisher', label: 'Fire extinguisher', hint: 'On board, gauge in the green, pin and seal in place, tag current.', critical: true },
  { id: 'steering', label: 'Steering', hint: 'Responds right away, with no excess play.', critical: true },
  { id: 'brakes', label: 'Brake test & function', hint: 'Service brakes stop and hold the machine. Parking brake holds on a grade.', critical: true },
  { id: 'tires', label: 'Tires/nuts / pressure', hint: 'Cuts, bulges or low pressure. Loose or missing lug nuts.' },
  { id: 'lights', label: 'Lights', hint: 'Head, tail, brake and work lights.' },
  { id: 'backup_alarm_horn', label: 'Backup alarm / horn', hint: 'Horn can be heard over the plant. Alarm sounds as soon as reverse is selected.', critical: true },
  { id: 'warning_lights', label: 'Warning lights', hint: 'Beacon or strobe, and the warning lights on the dash.' },
  { id: 'gauges', label: 'Gauges', hint: 'Normal readings at start-up.' },
  { id: 'windows_mirrors', label: 'Windows/mirrors (damage)', hint: 'Clean and in place. No cracks or damage that block your view.' },
  {
    id: 'seatbelts',
    label: 'Seatbelts/DROPS/FOPS',
    hint: 'Belt latches and retracts, webbing not cut or frayed. Roll-over and falling-object structure not cracked, bent or altered.',
    critical: true,
  },
  { id: 'controls', label: 'Controls', hint: 'Levers, pedals and joysticks work smoothly. Lockout and neutral-start work.', critical: true },
  { id: 'hyd_cyl_hoses', label: 'Hyd. cyl/hoses', hint: 'No leaks. Hoses not chafed, cracked or bulging.' },
  { id: 'wheel_chocks', label: 'Wheel chocks (2 each)', hint: 'Two on board, for any time you park on a grade.' },
  { id: 'appearance_damage', label: 'Appearance/damage', hint: 'New dents, cracks, broken welds or loose parts.' },
  { id: 'house_keeping', label: 'House keeping', hint: 'Cab floor and controls clear of loose items, mud and trash.' },
  { id: 'batteries', label: 'Batteries/secure/corrosion', hint: 'Held down, terminals tight and clean, cover on.' },
  { id: 'engine_oil', label: 'Engine oil', hint: 'Level on the dipstick. No leaks.' },
  { id: 'transmission_oil', label: 'Transmission oil', hint: 'Level. No leaks.' },
  { id: 'radiator_fluid', label: 'Radiator fluid', hint: 'Coolant level in the overflow tank. Never open a hot radiator cap.' },
  { id: FUEL_LINE, label: 'Fuel', hint: 'Enough for the job. Enter the gallons you add.' },
  { id: 'bed_condition', label: 'Bed condition', hint: 'Dump body or pickup bed, tailgate and pins. Nothing loose in it.' },
];

/** The MSHA standard behind a line, where it is the same for every machine. */
const MSHA: Record<string, string> = {
  fire_extinguisher: '56.4230',
  brakes: '56.14101',
  backup_alarm_horn: '56.14132',
  windows_mirrors: '56.14103',
  hyd_cyl_hoses: '56.4102',
  wheel_chocks: '56.14207',
  house_keeping: '56.14103',
};

/** Road-type vehicles: OSHA's motor-vehicle rule (1926.601) is the match. */
const VEHICLES: EquipmentCategory[] = ['water_truck', 'light_vehicle'];
/** The machines 30 CFR 56.14130 names: they need a roll-over structure and seat belts. */
const ROPS_MACHINES: EquipmentCategory[] = ['loader', 'dozer', 'grader', 'skid_steer'];
/** The lines OSHA's start-of-shift vehicle check, 1926.601(b)(14), lists by name. */
const VEHICLE_CHECK = ['steering', 'brakes', 'tires', 'lights', 'seatbelts', 'controls'];
/** The lines of a forklift's daily examination, 1910.178(q)(7). */
const FORKLIFT_CHECK = ['steering', 'brakes', 'tires', 'backup_alarm_horn', 'seatbelts', 'controls'];

function mshaFor(category: EquipmentCategory, id: string): string | undefined {
  if (id !== 'seatbelts') return MSHA[id];
  if (category === 'haul_truck') return '56.14131';
  // A forklift's overhead guard is falling-object protection.
  if (category === 'forklift') return '56.14106';
  // No standard is cited for a machine that none of them names.
  return ROPS_MACHINES.includes(category) ? '56.14130' : undefined;
}

/**
 * The OSHA rule that matches a line, by type of machine: forklifts fall under
 * the powered-industrial-truck standard, road vehicles under the motor-vehicle
 * standard, and the rest under earthmoving equipment.
 */
function oshaFor(category: EquipmentCategory, id: string): string | undefined {
  if (id === 'fire_extinguisher') return '1910.157(e)(2)';
  if (category === 'forklift') return FORKLIFT_CHECK.includes(id) ? '1910.178(q)(7)' : undefined;
  if (VEHICLES.includes(category)) {
    if (id === 'backup_alarm_horn') return '1926.601(b)(4)';
    if (id === 'windows_mirrors') return '1926.601(b)(5)';
    return VEHICLE_CHECK.includes(id) ? '1926.601(b)(14)' : undefined;
  }
  if (id === 'seatbelts') return '1926.602(a)(2)';
  if (id === 'brakes') return '1926.602(a)(4)';
  if (id === 'backup_alarm_horn') return '1926.602(a)(9)';
  return undefined;
}

const cache = new Map<EquipmentCategory, ChecklistTemplate>();

/** The checklist for a machine: the same 21 lines, with the standards that cover its type. */
/**
 * The checklist a signed checklist was made under, for the standards printed
 * beside its lines: the type of machine it was signed on, so an office change
 * of the unit's type does not change a signed record; else, for a checklist
 * signed before the type was kept on it, the unit's type now.
 */
export function checklistSignedOn(inspection: { category?: EquipmentCategory }, unit?: { category: EquipmentCategory } | null): ChecklistTemplate {
  return checklistFor(inspection.category ?? unit?.category ?? 'loader');
}

export function checklistFor(category: EquipmentCategory): ChecklistTemplate {
  const cached = cache.get(category);
  if (cached) return cached;
  const checklist: ChecklistTemplate = {
    id: CHECKLIST_ID,
    title: 'Operator equipment checklist',
    version: CHECKLIST_VERSION,
    items: LINES.map((line) => ({ ...line, cfr: mshaFor(category, line.id), osha: oshaFor(category, line.id) })),
  };
  cache.set(category, checklist);
  return checklist;
}

/** The marks, the way they are written in a box on the card. */
export const ANSWER_MARK: Record<Answer, string> = { ok: 'OK', bo: 'BO', na: 'N/A' };

/**
 * The legend printed at the foot of the card, word for word: each line follows
 * its mark and an equals sign, as in "OK = inspection free of defects/concerns".
 * The capitals and the punctuation are the paper's. Do not tidy them.
 */
export const ANSWER_LEGEND: Record<Answer, string> = {
  ok: 'inspection free of defects/concerns',
  bo: 'Bad Order, Needs Repair (Safety items; red tag and report immediately.)',
  na: 'Not applicable to specific equipment',
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

export function findItem(checklist: ChecklistTemplate, itemId: string): ChecklistItem | undefined {
  return checklist.items.find((i) => i.id === itemId);
}

/** A Bad Order on a safety item, or one the operator marked unsafe, takes the unit out of service. */
export function isHazard(checklist: ChecklistTemplate, answer: InspectionAnswer): boolean {
  if (answer.answer !== 'bo') return false;
  return !!answer.hazard || !!findItem(checklist, answer.itemId)?.critical;
}

const MARKS: Answer[] = ['ok', 'bo', 'na'];

/**
 * The answers as they go on the record: one for each line of the card, in the
 * card's order. A note, or the mark that a defect is unsafe to run with, stays
 * only on a Bad Order: one typed on a line that was then changed back to OK has
 * been withdrawn. `blank` counts the lines with no OK, BO or N/A yet.
 */
export function signedAnswers(
  checklist: ChecklistTemplate,
  answers: InspectionAnswer[],
): { answers: InspectionAnswer[]; blank: number } {
  const marked = new Map(answers.filter((a) => MARKS.includes(a.answer)).map((a) => [a.itemId, a]));
  const signed = checklist.items.flatMap((item): InspectionAnswer[] => {
    const mark = marked.get(item.id);
    if (!mark) return [];
    const bad = mark.answer === 'bo';
    const note = bad && mark.note ? cleanText(mark.note) : '';
    return [{ itemId: item.id, answer: mark.answer, ...(note ? { note } : null), ...(bad && mark.hazard ? { hazard: true } : null) }];
  });
  return { answers: signed, blank: checklist.items.length - signed.length };
}

export function inspectionResult(checklist: ChecklistTemplate, answers: InspectionAnswer[]): InspectionResult {
  const defects = answers.filter((a) => a.answer === 'bo');
  if (defects.length === 0) return 'pass';
  return defects.some((a) => isHazard(checklist, a)) ? 'bad_order' : 'defect';
}

export function countAnswers(answers: { answer: Answer }[]): Record<Answer, number> {
  const counts: Record<Answer, number> = { ok: 0, bo: 0, na: 0 };
  for (const a of answers) counts[a.answer] += 1;
  return counts;
}
