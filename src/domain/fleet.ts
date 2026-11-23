import { uid } from '../util/hash';
import { cleanText } from './roster';
import { CATEGORY_ORDER } from './templates';
import type { Equipment, EquipmentCategory, OperatingLog } from './types';

/**
 * The fleet: the units people check and take out. Every unit gets the same
 * equipment checklist; its type only picks the standards shown beside a line.
 *
 * The rules for adding a unit, changing what it is and taking it out of the
 * fleet live here, so the app and the office dashboard keep the same ones. A
 * unit's status and its equipment hours are not set here: they come from the
 * crew's checklists and maintenance requests.
 */

export interface UnitInput {
  unit: string;
  category: EquipmentCategory;
  make: string;
  model: string;
  /** Equipment hours now, or the odometer for a light vehicle. */
  meter: number;
}

export type UnitResult = { ok: true; unit: Equipment } | { ok: false; error: string };

/** A light vehicle is read by its odometer, in miles. Everything else is read in equipment hours. */
export function meterUnitFor(category: EquipmentCategory): Equipment['meterUnit'] {
  return category === 'light_vehicle' ? 'mi' : 'hrs';
}

/** An id for a new unit: random enough that a phone and the office never make the same one. */
export const newUnitId = () => uid('eq_');

/** A unit number the way it is painted on the machine: closed up and in capitals. */
export const unitNumber = (typed: string) => cleanText(typed).toUpperCase();

const NO_TYPE = 'Choose the type of equipment.';

/**
 * A new unit for the fleet, or why it cannot be added. A unit number is taken
 * when a unit in the fleet has the same one, whatever its capitals. A new unit
 * starts ready, at the reading given.
 */
export function newUnit(fleet: readonly Equipment[], input: UnitInput, id: string = newUnitId()): UnitResult {
  const name = unitNumber(input.unit);
  if (!name) return { ok: false, error: 'Enter a unit number.' };
  if (fleet.some((e) => e.unit.toUpperCase() === name)) return { ok: false, error: `Unit ${name} is already in the fleet.` };
  if (!CATEGORY_ORDER.includes(input.category)) return { ok: false, error: NO_TYPE };
  return {
    ok: true,
    unit: {
      id, unit: name, category: input.category, make: cleanText(input.make), model: cleanText(input.model),
      status: 'ready', meter: Number.isFinite(input.meter) ? input.meter : 0,
      meterUnit: meterUnitFor(input.category),
    },
  };
}

/**
 * A unit with its type, make and model changed, or why it cannot be. Its unit
 * number, status and reading stay as they are. The reading is in miles for a
 * light vehicle and in hours for anything else, so it follows the type.
 */
export function changedUnit(
  fleet: readonly Equipment[],
  unitId: string,
  change: Pick<UnitInput, 'category' | 'make' | 'model'>,
): UnitResult {
  const current = fleet.find((e) => e.id === unitId);
  if (!current) return { ok: false, error: 'That unit is no longer in the fleet.' };
  if (!CATEGORY_ORDER.includes(change.category)) return { ok: false, error: NO_TYPE };
  return {
    ok: true,
    unit: { ...current, category: change.category, make: cleanText(change.make), model: cleanText(change.model), meterUnit: meterUnitFor(change.category) },
  };
}

/** The fleet with a unit taken out. Its past checklists and requests stay on record. */
export function withoutUnit<T extends { id: string }>(fleet: readonly T[], unitId: string): T[] {
  return fleet.filter((e) => e.id !== unitId);
}

/**
 * A unit this person has checked out on this phone, to check back in with End use, or null: the unit of a
 * use of theirs that has not ended, in the fleet or kept in `gone` (`Receiving`) because the company took
 * it out of the fleet while it was checked out here. A use whose unit is in neither is shown nowhere on
 * the phone and cannot be ended, so it is never one.
 */
export function unitCheckedOut(
  employeeId: string,
  opLogs: readonly OperatingLog[],
  fleet: readonly Equipment[],
  gone: Readonly<Record<string, Equipment>> | null | undefined,
): Equipment | null {
  for (const log of opLogs) {
    if (log.employeeId !== employeeId || log.endAt) continue;
    const unit = fleet.find((e) => e.id === log.equipmentId) ?? gone?.[log.equipmentId];
    if (unit) return unit;
  }
  return null;
}

/**
 * A reading as typed: "4,250.5" is 4250.5, and nothing typed is 0. Undefined
 * when it is not a number a meter shows.
 */
export function readMeter(typed: string): number | undefined {
  const text = typed.trim().replace(/,/g, '');
  if (!text) return 0;
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) && n <= 9_999_999 ? n : undefined;
}

/** The fleet in the order it is listed: by type, then by unit number, with L-2 ahead of L-10. */
export function fleetOrder<T extends Pick<Equipment, 'category' | 'unit'>>(fleet: readonly T[]): T[] {
  return [...fleet].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.unit.localeCompare(b.unit, undefined, { numeric: true }),
  );
}
