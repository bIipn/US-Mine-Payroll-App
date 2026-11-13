import { checkFix, circleAcres, destination, haversineM, offsetM, pointInPolygon, toGeoStamp } from '../geofence';
import { DEFAULT_SITE, IONE_TOWN_CENTER, MINE_CENTER } from '../site';

const north = (m: number) => destination(MINE_CENTER, 0, m);

describe('distance', () => {
  it('puts downtown Ione about 1.45 miles from the mine pin', () => {
    const metres = haversineM(MINE_CENTER, IONE_TOWN_CENTER);
    expect(metres).toBeGreaterThan(2300);
    expect(metres).toBeLessThan(2380);
  });
  it('round-trips offsets', () => {
    const p = destination(MINE_CENTER, 400, -250);
    const o = offsetM(MINE_CENTER, p);
    expect(o.east).toBeCloseTo(400, 3);
    expect(o.north).toBeCloseTo(-250, 3);
    expect(haversineM(MINE_CENTER, p)).toBeCloseTo(Math.hypot(400, 250), 0);
  });
});

describe('checkFix', () => {
  it('accepts a fix inside the boundary', () => {
    const check = checkFix(DEFAULT_SITE, { ...north(300), accuracyM: 6 });
    expect(check.verdict).toBe('inside');
    expect(check.marginM).toBeCloseTo(700, 0);
  });
  it('keeps the town of Ione outside the default boundary', () => {
    const check = checkFix(DEFAULT_SITE, { ...IONE_TOWN_CENTER, accuracyM: 5 });
    expect(check.verdict).toBe('outside');
    expect(check.marginM).toBeLessThan(-1300);
  });
  it('gives the employee at most 50 m of GPS error at the edge', () => {
    expect(checkFix(DEFAULT_SITE, { ...north(1030), accuracyM: 40 }).verdict).toBe('inside');
    expect(checkFix(DEFAULT_SITE, { ...north(1045), accuracyM: 40 }).verdict).toBe('outside');
    expect(checkFix(DEFAULT_SITE, { ...north(1060), accuracyM: 150 }).verdict).toBe('outside');
    expect(checkFix(DEFAULT_SITE, { ...north(1045), accuracyM: 150 }).verdict).toBe('inside');
  });
  it('rejects a fix too vague to trust', () => {
    expect(checkFix(DEFAULT_SITE, { ...north(100), accuracyM: 450 }).verdict).toBe('weak_gps');
  });
  it('rejects a simulated location even when it is inside', () => {
    expect(checkFix(DEFAULT_SITE, { ...north(100), accuracyM: 5, mocked: true }).verdict).toBe('mocked');
  });
  it('uses a surveyed outline in place of the circle when one is set', () => {
    const polygon = [
      destination(MINE_CENTER, -200, -200), destination(MINE_CENTER, 200, -200),
      destination(MINE_CENTER, 200, 200), destination(MINE_CENTER, -200, 200),
    ];
    const site = { ...DEFAULT_SITE, polygon };
    expect(pointInPolygon(north(150), polygon)).toBe(true);
    expect(checkFix(site, { ...north(150), accuracyM: 5 }).verdict).toBe('inside');
    expect(checkFix(site, { ...north(400), accuracyM: 5 }).verdict).toBe('outside');
  });
});

describe('toGeoStamp', () => {
  it('records distance and the inside flag on a punch', () => {
    const stamp = toGeoStamp(DEFAULT_SITE, { ...north(250), accuracyM: 9 }, 'gps');
    expect(stamp).toMatchObject({ distanceM: 250, inside: true, source: 'gps', accuracyM: 9 });
    expect(stamp.mocked).toBeUndefined();
  });
});

describe('circleAcres', () => {
  it('converts the default boundary to acres', () => {
    expect(Math.round(circleAcres(1000))).toBe(776);
  });
});
