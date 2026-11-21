import {
  checkFix,
  circleAcres,
  clockInTurnDown,
  clockInVerdict,
  destination,
  haversineM,
  MAX_ACCURACY_M,
  offsetM,
  pointInPolygon,
  toGeoStamp,
  turnDownOf,
  type RawFix,
} from '../geofence';
import { awayFromSite, SAMPLE_SITE } from '../site';

const MINE_CENTER = SAMPLE_SITE.center;
const DEFAULT_SITE = SAMPLE_SITE;
const north = (m: number) => destination(MINE_CENTER, 0, m);

describe('the sample site', () => {
  it('is made up: round numbers, named for the sample company, with a town for reference about 1.5 miles off', () => {
    expect(SAMPLE_SITE.center).toEqual({ lat: 39.5, lng: -116.5 });
    expect(SAMPLE_SITE.name).toBe('Sample Mining Co. pit');
    const metres = haversineM(MINE_CENTER, SAMPLE_SITE.town!.center);
    expect(metres).toBeGreaterThan(2300);
    expect(metres).toBeLessThan(2500);
  });

  it('puts a phone "away from the mine" in the town, or well outside a site with none', () => {
    expect(awayFromSite(SAMPLE_SITE)).toEqual(SAMPLE_SITE.town!.center);
    const bare = { name: 'Pit', center: MINE_CENTER, radiusM: 1500 };
    expect(checkFix(bare, { ...awayFromSite(bare), accuracyM: 5 }).verdict).toBe('outside');
  });
});

describe('distance', () => {
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
  it('keeps the town outside the sample boundary', () => {
    const check = checkFix(DEFAULT_SITE, { ...SAMPLE_SITE.town!.center, accuracyM: 5 });
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

describe('clockInVerdict', () => {
  const gps = (fix: RawFix) => ({ fix, source: 'gps' as const });
  const town: RawFix = { ...SAMPLE_SITE.town!.center, accuracyM: 5 };

  it('lets a clock-in through with its position when the phone puts it inside the boundary', () => {
    const fix = { ...north(300), accuracyM: 6 };
    expect(clockInVerdict(DEFAULT_SITE, gps(fix))).toEqual({ ok: true, geo: toGeoStamp(DEFAULT_SITE, fix, 'gps') });
  });

  it('turns down a trusted position outside the boundary, a simulated one and one too vague to trust, with where it was', () => {
    expect(clockInVerdict(DEFAULT_SITE, gps(town))).toEqual({ ok: false, kind: 'outside', geo: toGeoStamp(DEFAULT_SITE, town, 'gps') });
    expect(clockInVerdict(DEFAULT_SITE, gps({ ...north(100), accuracyM: 5, mocked: true }))).toMatchObject({
      ok: false, kind: 'mocked', geo: { inside: false, mocked: true },
    });
    expect(clockInVerdict(DEFAULT_SITE, gps({ ...north(100), accuracyM: 250 }))).toMatchObject({
      ok: false, kind: 'weak_gps', geo: { inside: false, accuracyM: 250 },
    });
  });

  it('lets a clock-in with no position through, saying why there is none: it is never turned down for want of one', () => {
    for (const none of ['off', 'approximate', 'no_fix'] as const) {
      expect(clockInVerdict(DEFAULT_SITE, { none })).toEqual({ ok: true, noLocation: none });
    }
  });

  it('decides the way checkFix does, for every kind of fix', () => {
    const fixes: RawFix[] = [
      { ...north(300), accuracyM: 6 }, { ...north(1030), accuracyM: 40 }, { ...north(1045), accuracyM: 40 },
      town, { ...north(100), accuracyM: 5, mocked: true }, { ...north(100), accuracyM: 450 }, { ...north(50), accuracyM: null },
    ];
    for (const fix of fixes) {
      const verdict = clockInVerdict(DEFAULT_SITE, gps(fix));
      expect(verdict.ok ? 'inside' : verdict.kind).toBe(checkFix(DEFAULT_SITE, fix).verdict);
    }
  });
});

describe('turnDownOf', () => {
  const stamp = (fix: RawFix) => toGeoStamp(DEFAULT_SITE, fix, 'gps');

  it('says why a stamped position may not clock in, and nothing for one inside the boundary', () => {
    expect(turnDownOf(stamp({ ...north(300), accuracyM: 6 }))).toBeUndefined();
    expect(turnDownOf(stamp({ ...SAMPLE_SITE.town!.center, accuracyM: 5 }))).toBe('outside');
    expect(turnDownOf(stamp({ ...north(100), accuracyM: 5, mocked: true }))).toBe('mocked');
    expect(turnDownOf(stamp({ ...north(100), accuracyM: MAX_ACCURACY_M + 50 }))).toBe('weak_gps');
  });

  it('turns down a simulated position even when it says it is inside', () => {
    expect(turnDownOf({ ...stamp({ ...north(100), accuracyM: 5 }), mocked: true })).toBe('mocked');
  });
});

describe('clockInTurnDown', () => {
  const stamp = (fix: RawFix) => toGeoStamp(DEFAULT_SITE, fix, 'gps');
  const inside = stamp({ ...north(300), accuracyM: 6 });

  it('turns down every clock-in while no boundary is set, with a location or without', () => {
    for (const where of [inside, 'off', 'approximate', 'no_fix'] as const) expect(clockInTurnDown(null, where)).toBe('no_site');
  });

  it('lets a clock-in with no location through once a boundary is set, and judges a position the way turnDownOf does', () => {
    for (const none of ['off', 'approximate', 'no_fix'] as const) expect(clockInTurnDown(DEFAULT_SITE, none)).toBeUndefined();
    expect(clockInTurnDown(DEFAULT_SITE, inside)).toBeUndefined();
    const town = stamp({ ...SAMPLE_SITE.town!.center, accuracyM: 5 });
    expect(clockInTurnDown(DEFAULT_SITE, town)).toBe('outside');
    expect(clockInTurnDown(DEFAULT_SITE, { ...inside, mocked: true })).toBe('mocked');
    expect(clockInTurnDown(DEFAULT_SITE, stamp({ ...north(100), accuracyM: MAX_ACCURACY_M + 50 }))).toBe('weak_gps');
  });
});

describe('circleAcres', () => {
  it('converts the default boundary to acres', () => {
    expect(Math.round(circleAcres(1000))).toBe(776);
  });
});
