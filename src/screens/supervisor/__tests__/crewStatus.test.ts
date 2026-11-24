import { toGeoStamp } from '../../../domain/geofence';
import { SAMPLE_SITE } from '../../../domain/site';
import type { Employee, Shift } from '../../../domain/types';
import { crewNow } from '../crewStatus';

const at = (h: number, m = 0) => new Date(2026, 10, 13, h, m).getTime();
const person = (id: string, lastName: string): Employee => ({ id, firstName: 'Sample', lastName, role: 'employee', active: true });
const onSite = toGeoStamp(SAMPLE_SITE, { ...SAMPLE_SITE.center, accuracyM: 5 }, 'gps');

describe('who is on site', () => {
  it('marks a person who clocked in with no location, so the list shows that clock-in was not checked', () => {
    const shifts: Shift[] = [
      { id: 's1', employeeId: 'a', clockIn: { at: at(6), noLocation: 'off' }, lunches: [], breaks: [] },
      { id: 's2', employeeId: 'b', clockIn: { at: at(6), geo: onSite }, lunches: [], breaks: [] },
    ];
    const lines = crewNow([person('a', 'Alpha'), person('b', 'Bravo'), person('c', 'Charlie')], shifts, at(8));
    const line = (id: string) => lines.find((l) => l.employee.id === id)!;
    expect(line('a')).toMatchObject({ presence: 'working', noLocation: true });
    expect(line('b')).toMatchObject({ presence: 'working', noLocation: false });
    expect(line('c').presence).toBe('off');
    expect(line('c').noLocation).toBeFalsy();
  });
});
