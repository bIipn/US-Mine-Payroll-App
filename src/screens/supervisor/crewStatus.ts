import { mealStatus, shiftFlags, shiftTotals, type MealState } from '../../domain/time';
import type { Employee, Shift } from '../../domain/types';
import type { Tone } from '../../theme/theme';
import { fmtDur, fmtTime } from '../../util/format';

export type Presence = 'working' | 'lunch' | 'off';

export interface CrewLine {
  employee: Employee;
  shift?: Shift;
  presence: Presence;
  meal?: MealState;
  /** Short status for a tag. */
  label: string;
  tone: Tone;
  solid?: boolean;
  /** Higher sorts first: the people a supervisor has to look at. */
  urgency: number;
  paid: number;
}

/** Where each active person stands right now. */
export function crewNow(employees: Employee[], shifts: Shift[], now: number): CrewLine[] {
  const open = new Map<string, Shift>();
  for (const shift of shifts) {
    if (!shift.clockOut && !shiftFlags(shift, now).includes('missing_out')) open.set(shift.employeeId, shift);
  }
  return employees
    .filter((e) => e.active)
    .map((employee): CrewLine => {
      const shift = open.get(employee.id);
      if (!shift) return { employee, presence: 'off', label: 'Off', tone: 'neutral', urgency: 0, paid: 0 };
      const meal = mealStatus(shift, now);
      const paid = shiftTotals(shift, now).paid;
      const base = { employee, shift, meal: meal.state, paid };
      switch (meal.state) {
        case 'at_lunch':
          // Lunch ends by itself, so the board can say when the person is back on the clock.
          return { ...base, presence: 'lunch', label: `At lunch until ${fmtTime(meal.lunchEndsAt ?? now)}`, tone: 'info', urgency: 1 };
        case 'overdue':
          return { ...base, presence: 'working', label: 'Lunch overdue', tone: 'bo', solid: true, urgency: 5 };
        case 'urgent':
          return { ...base, presence: 'working', label: `Lunch due in ${fmtDur(meal.remainingMs)}`, tone: 'bo', urgency: 4 };
        case 'soon':
          return { ...base, presence: 'working', label: `Lunch due in ${fmtDur(meal.remainingMs)}`, tone: 'warn', urgency: 3 };
        default:
          return { ...base, presence: 'working', label: 'Working', tone: 'ok', urgency: 2 };
      }
    })
    .sort((a, b) => b.urgency - a.urgency || a.employee.lastName.localeCompare(b.employee.lastName));
}

export function missingClockOuts(shifts: Shift[], now: number): Shift[] {
  return shifts.filter((s) => !s.clockOut && shiftFlags(s, now).includes('missing_out'));
}
