import { checkCompany, companyOrDefault, keepsTime, normalMineId, parseCompany, SAMPLE_COMPANY, signInWords, stateName, STATES, type Company } from '../company';

describe('the company a build names', () => {
  const setting = JSON.stringify({
    name: 'Example Aggregates Co.',
    state: 'nv',
    place: 'Fallon, Nevada',
    logo: 'https://example.com/logo.png',
    pay: { frequency: 'monthly', payday: { dayOfMonth: [5] }, ifBankClosed: 'before' },
  });

  it('reads a whole company', () => {
    expect(parseCompany(setting)).toEqual({
      company: {
        name: 'Example Aggregates Co.',
        state: 'NV',
        place: 'Fallon, Nevada',
        logo: { uri: 'https://example.com/logo.png' },
        pay: { frequency: 'monthly', payday: { dayOfMonth: [5] }, ifBankClosed: 'before' },
      },
    });
  });

  it('is nothing when the setting is empty', () => {
    expect(parseCompany(undefined)).toEqual({});
    expect(parseCompany('  ')).toEqual({});
  });

  it('reads the MSHA mine ID a build gives', () => {
    expect(parseCompany('{"name":"A","state":"NV","mineId":"26-01234"}').company?.mineId).toBe('2601234');
    expect(parseCompany('{"name":"A","state":"NV","mineId":"26"}').error).toMatch(/mine ID/);
  });

  it('reads the site a build names with the company: the pin, the circle and a town for reference', () => {
    const { site } = parseCompany('{"name":"A","state":"NV","site":{"name":"North pit","lat":40.25,"lng":-117.5,"radiusM":1200,"town":{"name":"Elm","lat":40.27,"lng":-117.49}}}');
    expect(site).toEqual({ name: 'North pit', center: { lat: 40.25, lng: -117.5 }, radiusM: 1200, town: { name: 'Elm', center: { lat: 40.27, lng: -117.49 } } });
    expect(parseCompany('{"name":"A","state":"NV","site":{"lat":40.25,"lng":-117.5}}').site).toEqual({ name: 'A', center: { lat: 40.25, lng: -117.5 }, radiusM: 1000 });
    expect(parseCompany('{"name":"A","state":"NV","site":{"lat":40.25,"lng":-117.5,"radiusM":9000}}').site!.radiusM).toBe(2000);
    expect(parseCompany('{"name":"A","state":"NV","site":{"lat":95,"lng":-117.5}}').error).toMatch(/site/);
    expect(parseCompany('{"name":"A","state":"NV","site":{"lat":"x","lng":-117.5}}').error).toMatch(/site/);
    expect(parseCompany('{"name":"A","state":"NV"}').site).toBeUndefined();
  });

  it('keeps time unless the build says the crew uses the safety forms only', () => {
    expect(keepsTime(parseCompany('{"name":"A","state":"NV"}').company!)).toBe(true);
    const safetyOnly = parseCompany('{"name":"A","state":"NV","timeClock":false}').company!;
    expect(safetyOnly.timeClock).toBe(false);
    expect(keepsTime(safetyOnly)).toBe(false);
    expect(parseCompany('{"name":"A","state":"NV","timeClock":"no"}').error).toMatch(/timeClock/);
  });

  it('takes a company with no pay periods and no logo', () => {
    expect(parseCompany('{"name":"Example Aggregates Co.","state":"TX"}')).toEqual({
      company: { name: 'Example Aggregates Co.', state: 'TX', pay: null },
    });
  });

  it('names the built-in logo art by its key', () => {
    expect(parseCompany('{"name":"A","state":"CA","logo":"us-mine"}').company?.logo).toEqual({ art: 'us-mine' });
  });

  it('takes an uploaded image as a data URL', () => {
    const uri = 'data:image/png;base64,iVBORw0KGgo=';
    expect(parseCompany(JSON.stringify({ name: 'A', state: 'CA', logo: uri })).company?.logo).toEqual({ uri });
  });

  it('says what is wrong with a setting it cannot use', () => {
    expect(parseCompany('{name: A}').error).toMatch(/JSON/);
    expect(parseCompany('{"state":"CA"}').error).toMatch(/name/);
    expect(parseCompany('{"name":"A","state":"ZZ"}').error).toMatch(/state/);
    expect(parseCompany('{"name":"A","state":"CA","logo":"http://example.com/a.png"}').error).toMatch(/logo/);
    expect(parseCompany('{"name":"A","state":"CA","pay":{"frequency":"weekly"}}').error).toMatch(/pay/i);
  });
});

describe('what the sign-in screens say the app is for', () => {
  const company: Company = { name: 'Test Pit A', state: 'NV', pay: null };
  const timeOrPay = /clock|paid|\bpay\b|\btime\b|hours/i;

  it('says nothing of time or pay before the phone knows the company', () => {
    const words = signInWords(null);
    expect(`${words.tagline} ${words.line}`).not.toMatch(timeOrPay);
    expect(words).toEqual({ tagline: 'Check your machine. Report what needs fixing.', line: 'Equipment checklists, pre shift exams and maintenance requests for the crew.' });
  });

  it('keeps the words it always had for a company that keeps time', () => {
    expect(signInWords(company)).toEqual({ tagline: 'Clock in. Check your machine. Get paid right.', line: 'Time, checklists and maintenance requests for the crew.' });
    expect(signInWords({ ...company, place: 'Test Flats' }).line).toBe('Time, checklists and maintenance requests for the crew at Test Flats.');
  });

  it('says nothing of time or pay for a company that uses the safety forms alone', () => {
    const words = signInWords({ ...company, timeClock: false, place: 'Test Flats' });
    expect(`${words.tagline} ${words.line}`).not.toMatch(timeOrPay);
    expect(words.line).toBe('Equipment checklists, pre shift exams and maintenance requests for the crew at Test Flats.');
  });
});

describe('checkCompany', () => {
  const company: Company = { name: 'Example Aggregates Co.', state: 'CA', pay: null };

  it('passes a company with a name and a state', () => {
    expect(checkCompany(company)).toBeUndefined();
  });

  it('takes the company’s own earning codes for the payroll file, one for each kind of hours', () => {
    const codes = { regular: 'R', overtime: 'O', double: 'D', holiday: 'HOL', pto: 'VAC', sick: 'SICK 1' };
    expect(checkCompany({ ...company, payCodes: codes })).toBeUndefined();
    expect(checkCompany({ ...company, payCodes: { ...codes, pto: ' ' } })).toMatch(/earning code/);
    expect(checkCompany({ ...company, payCodes: { ...codes, pto: 'A,B' } })).toMatch(/earning code/);
    expect(checkCompany({ ...company, payCodes: { ...codes, pto: 'R' } })).toMatch(/same code/);
  });

  it('takes an MSHA mine ID of seven digits, written with or without a dash or spaces', () => {
    expect(checkCompany({ ...company, mineId: '0400123' })).toBeUndefined();
    expect(checkCompany({ ...company, mineId: '04-00123' })).toBeUndefined();
    expect(checkCompany({ ...company, mineId: '04001' })).toMatch(/seven digits/);
    expect(checkCompany({ ...company, mineId: 'MINE123' })).toMatch(/seven digits/);
    expect(normalMineId(' 04-00 123 ')).toBe('0400123');
  });

  it('turns back a blank name, an unknown state and a pay schedule that cannot be worked out', () => {
    expect(checkCompany({ ...company, name: '  ' })).toMatch(/name/);
    expect(checkCompany({ ...company, state: 'XX' })).toMatch(/state/);
    expect(checkCompany({ ...company, pay: { frequency: 'weekly', payday: { daysAfter: 5 }, ifBankClosed: 'before' } })).toMatch(/first day/);
  });
});

describe('states', () => {
  it('lists the fifty states and the District of Columbia', () => {
    expect(Object.keys(STATES)).toHaveLength(51);
    expect(stateName('CA')).toBe('California');
    expect(stateName('DC')).toBe('District of Columbia');
    expect(stateName('')).toBe('');
  });
});

describe('companyOrDefault', () => {
  it('uses the build’s company when there is one', () => {
    const own: Company = { name: 'Example Aggregates Co.', state: 'TX', pay: null };
    expect(companyOrDefault(own, false)).toBe(own);
  });

  it('starts a preview with the made-up sample company', () => {
    expect(companyOrDefault(undefined, true)).toBe(SAMPLE_COMPANY);
  });

  it('starts a real crew with no company details until a supervisor gives them', () => {
    expect(companyOrDefault(undefined, false)).toEqual({ name: '', state: '', pay: null });
  });

  it('keeps the sample company made up', () => {
    expect(SAMPLE_COMPANY.name).toMatch(/^Sample /);
    expect(SAMPLE_COMPANY.logo).toBeUndefined();
  });
});

describe('the company a build on this machine names', () => {
  // Jest does not load .env.local, so this reads it itself, and only where a build on this
  // machine names its company there. Nowhere else is there anything to check.
  const setting = (() => {
    // This project has no Node types, so the file system is asked for by name with the two calls used here.
    const fs = jest.requireActual<{ existsSync(file: string): boolean; readFileSync(file: string, encoding: 'utf8'): string }>('fs');
    const here = expect.getState().testPath ?? '';
    const file = `${here.slice(0, here.search(/[\\/]src[\\/]/))}/.env.local`;
    if (!fs.existsSync(file)) return undefined;
    const found = fs.readFileSync(file, 'utf8').match(/^EXPO_PUBLIC_COMPANY=(?:"([\s\S]*?)"|'([\s\S]*?)'|(.*))$/m);
    return found ? found[1] ?? found[2] ?? found[3] : undefined;
  })();

  (setting ? it : it.skip)('can be read, so the build does not start without it', () => {
    // Only the error is printed if this fails, never the setting itself.
    expect(parseCompany(setting).error).toBeUndefined();
  });

  (setting ? it : it.skip)('is not the made-up sample company', () => {
    expect(parseCompany(setting).company?.name).not.toBe(SAMPLE_COMPANY.name);
  });
});
