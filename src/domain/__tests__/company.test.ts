import { checkCompany, companyOrDefault, parseCompany, SAMPLE_COMPANY, stateName, STATES, type Company } from '../company';

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

describe('checkCompany', () => {
  const company: Company = { name: 'Example Aggregates Co.', state: 'CA', pay: null };

  it('passes a company with a name and a state', () => {
    expect(checkCompany(company)).toBeUndefined();
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
