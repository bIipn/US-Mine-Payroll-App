import { changedUnit, fleetOrder, meterUnitFor, newUnit, newUnitId, readMeter, unitNumber, unitReadingProblem, unitsCheckedOut, withoutUnit } from '../fleet';
import type { Equipment, OperatingLog } from '../types';

const loader: Equipment = { id: 'eq_a', unit: 'L-2', category: 'loader', make: 'Test', model: 'One', status: 'ready', meter: 4250.5, meterUnit: 'hrs' };
const truck: Equipment = { id: 'eq_b', unit: 'T-10', category: 'haul_truck', make: 'Test', model: 'Two', status: 'out_of_service', meter: 9120, meterUnit: 'hrs' };
const pickup: Equipment = { id: 'eq_c', unit: 'P-4', category: 'light_vehicle', make: 'Test', model: 'Three', status: 'defect', meter: 61200, meterUnit: 'mi' };
const fleet = [loader, truck, pickup];

describe('adding a unit to the fleet', () => {
  it('makes a unit that starts ready at the reading given, with the number in capitals and the words closed up', () => {
    expect(newUnit(fleet, { unit: '  l-16 ', category: 'loader', make: ' Test   Make ', model: ' 980 m ', meter: 120.5 }, 'eq_new')).toEqual({
      ok: true,
      unit: { id: 'eq_new', unit: 'L-16', category: 'loader', make: 'Test Make', model: '980 m', status: 'ready', meter: 120.5, meterUnit: 'hrs' },
    });
  });

  it('reads a light vehicle in miles and everything else in equipment hours', () => {
    expect(meterUnitFor('light_vehicle')).toBe('mi');
    expect(meterUnitFor('water_truck')).toBe('hrs');
    const made = newUnit(fleet, { unit: 'P-9', category: 'light_vehicle', make: '', model: '', meter: 30 }, 'eq_p');
    expect(made.ok && made.unit.meterUnit).toBe('mi');
  });

  it('needs a unit number', () => {
    expect(newUnit(fleet, { unit: '   ', category: 'loader', make: 'Test', model: 'One', meter: 0 })).toEqual({ ok: false, error: 'Enter a unit number.' });
  });

  it('starts at a reading a meter shows, or is not added', () => {
    // A minus sign typed on an Android number pad, or a reading that could not be read: never 0 hours without a word.
    for (const meter of [-5, Number.NaN, Number.POSITIVE_INFINITY, 10_000_001]) {
      expect(newUnit(fleet, { unit: 'L-16', category: 'loader', make: 'Test', model: 'One', meter })).toEqual({
        ok: false, error: 'Enter the equipment hours as a number, like 4250.5, or leave it blank.',
      });
    }
    expect(newUnit(fleet, { unit: 'P-9', category: 'light_vehicle', make: 'Test', model: 'One', meter: -1 })).toEqual({
      ok: false, error: 'Enter the odometer as a number of miles, like 61200, or leave it blank.',
    });
    const made = newUnit(fleet, { unit: 'L-16', category: 'loader', make: 'Test', model: 'One', meter: 0 }, 'eq_new');
    expect(made.ok && made.unit.meter).toBe(0);
  });

  it('says how to type the hours with the decimal mark of the phone it is added on', () => {
    // A phone that writes 12,5 for twelve and a half has a comma on its number pad and no point.
    expect(unitReadingProblem('loader', ',')).toBe('Enter the equipment hours as a number, like 4250,5, or leave it blank.');
    expect(unitReadingProblem('loader')).toBe(unitReadingProblem('loader', '.'));
    expect(unitReadingProblem('light_vehicle', ',')).toBe(unitReadingProblem('light_vehicle'));
    expect(newUnit(fleet, { unit: 'L-16', category: 'loader', make: 'Test', model: 'One', meter: -5 }, 'eq_new', ',')).toEqual({
      ok: false, error: 'Enter the equipment hours as a number, like 4250,5, or leave it blank.',
    });
  });

  it('takes a unit number as taken whatever its capitals or the spaces around it', () => {
    expect(newUnit(fleet, { unit: ' t-10 ', category: 'haul_truck', make: 'Test', model: 'One', meter: 0 })).toEqual({ ok: false, error: 'Unit T-10 is already in the fleet.' });
    expect(unitNumber(' t-10 ')).toBe('T-10');
  });

  it('needs a type of equipment the app has', () => {
    expect(newUnit(fleet, { unit: 'X-1', category: 'crane' as never, make: 'Test', model: 'One', meter: 0 })).toEqual({ ok: false, error: 'Choose the type of equipment.' });
  });

  it('starts at zero only when nothing is typed, never for a reading that is not a number', () => {
    // Nothing typed is 0 (readMeter, on the phone and the dashboard); a reading that could not be read is turned back.
    const blank = newUnit(fleet, { unit: 'X-1', category: 'dozer', make: '', model: '', meter: readMeter('') ?? Number.NaN }, 'eq_x');
    expect(blank.ok && blank.unit.meter).toBe(0);
    expect(newUnit(fleet, { unit: 'X-1', category: 'dozer', make: '', model: '', meter: Number.NaN }, 'eq_x')).toMatchObject({ ok: false });
  });

  it('gives each new unit an id of its own, as the app gives its records', () => {
    const [a, b] = [newUnitId(), newUnitId()];
    expect(a).toMatch(/^eq_[a-z0-9]{12,}$/);
    expect(a).not.toBe(b);
    const made = newUnit(fleet, { unit: 'X-2', category: 'dozer', make: '', model: '', meter: 0 });
    expect(made.ok && made.unit.id).toMatch(/^eq_/);
  });
});

describe('changing a unit', () => {
  it('changes its type, make and model and nothing else: the number, the status and the reading stay', () => {
    expect(changedUnit(fleet, 'eq_b', { category: 'water_truck', make: ' New  Make ', model: ' 4000 ' })).toEqual({
      ok: true,
      unit: { id: 'eq_b', unit: 'T-10', category: 'water_truck', make: 'New Make', model: '4000', status: 'out_of_service', meter: 9120, meterUnit: 'hrs' },
    });
  });

  it('keeps anything else the record holds', () => {
    const withMore = { ...loader, note: 'kept' } as Equipment;
    const made = changedUnit([withMore], 'eq_a', { category: 'loader', make: 'Test', model: 'One' });
    expect(made.ok && made.unit).toEqual(withMore);
  });

  it('reads the unit in miles once it is a light vehicle, and in hours once it is not', () => {
    const toPickup = changedUnit(fleet, 'eq_a', { category: 'light_vehicle', make: 'Test', model: 'One' });
    expect(toPickup.ok && toPickup.unit.meterUnit).toBe('mi');
    const toLoader = changedUnit(fleet, 'eq_c', { category: 'loader', make: 'Test', model: 'Three' });
    expect(toLoader.ok && toLoader.unit.meterUnit).toBe('hrs');
  });

  it('turns back a unit that is no longer in the fleet, and a type the app does not have', () => {
    expect(changedUnit(fleet, 'eq_gone', { category: 'loader', make: '', model: '' })).toEqual({ ok: false, error: 'That unit is no longer in the fleet.' });
    expect(changedUnit(fleet, 'eq_a', { category: 'crane' as never, make: '', model: '' })).toEqual({ ok: false, error: 'Choose the type of equipment.' });
  });
});

describe('taking a unit out of the fleet', () => {
  it('leaves the others as they were', () => {
    expect(withoutUnit(fleet, 'eq_b')).toEqual([loader, pickup]);
    expect(withoutUnit(fleet, 'eq_gone')).toEqual(fleet);
  });
});

describe('a reading as typed', () => {
  it('reads hours with a comma and a tenth, and nothing typed as zero', () => {
    expect(readMeter('4,250.5')).toBe(4250.5);
    expect(readMeter(' 120 ')).toBe(120);
    expect(readMeter('.5')).toBe(0.5);
    expect(readMeter('')).toBe(0);
    expect(readMeter('   ')).toBe(0);
  });

  it('is not a reading when it is not a number a meter shows', () => {
    // A minus sign or a space between digits, as an Android number pad can type them: turned back, never 0.
    for (const typed of ['abc', '-5', '12 000', '12 hrs', '1e9', '4.2.1', '.', '99999999']) expect(readMeter(typed)).toBeUndefined();
  });

  it('reads it by the decimal mark of the phone it is typed on', () => {
    expect(readMeter('4250,5', ',')).toBe(4250.5);
    expect(readMeter('4.250,5', ',')).toBe(4250.5);
    expect(readMeter('', ',')).toBe(0);
    expect(readMeter('4250,5')).toBeUndefined();
    for (const typed of ['-5', '12 5', '12,', '1,000.5']) expect(readMeter(typed, ',')).toBeUndefined();
  });
});

describe('the fleet as it is listed', () => {
  it('goes by type, then by unit number, with 2 ahead of 10', () => {
    const more: Equipment[] = [
      { ...loader, id: 'l10', unit: 'L-10' },
      pickup,
      truck,
      loader,
    ];
    expect(fleetOrder(more).map((e) => e.unit)).toEqual(['L-2', 'L-10', 'T-10', 'P-4']);
    // The list handed in is left as it was.
    expect(more[0].unit).toBe('L-10');
  });
});

describe('the units someone has checked out', () => {
  const use = (id: string, equipmentId: string, employeeId: string, endAt?: number): OperatingLog => ({
    id,
    equipmentId,
    employeeId,
    inspectionId: `insp_${id}`,
    startAt: 1_000,
    startMeter: 100,
    ...(endAt ? { endAt } : null),
  });

  it('are the units of their uses that have not ended, in the fleet or kept until the use ends', () => {
    const mine = use('op1', 'eq_a', 'emp_lee');
    expect(unitsCheckedOut('emp_lee', [mine], fleet, null)).toEqual([{ log: mine, unit: loader, takenOut: false }]);
    // Ended, or someone else's: not theirs to check back in.
    expect(unitsCheckedOut('emp_lee', [use('op1', 'eq_a', 'emp_lee', 2_000), use('op2', 'eq_b', 'emp_sam')], fleet, null)).toEqual([]);
    // The company took one out of the fleet while it was checked out here: the phone keeps it until its use is ended.
    const takenOut = { ...truck, id: 'eq_gone', unit: 'T-77' };
    const gone = use('op2', 'eq_gone', 'emp_lee');
    expect(unitsCheckedOut('emp_lee', [mine, gone], fleet, { eq_gone: takenOut })).toEqual([
      { log: mine, unit: loader, takenOut: false },
      { log: gone, unit: takenOut, takenOut: true },
    ]);
  });

  it('are never a use whose unit is nowhere on the phone, which nothing shows and nothing could end', () => {
    expect(unitsCheckedOut('emp_lee', [use('op1', 'eq_nowhere', 'emp_lee')], fleet, {})).toEqual([]);
    const later = use('op2', 'eq_c', 'emp_lee');
    expect(unitsCheckedOut('emp_lee', [use('op1', 'eq_nowhere', 'emp_lee'), later], fleet, {})).toEqual([{ log: later, unit: pickup, takenOut: false }]);
  });
});
