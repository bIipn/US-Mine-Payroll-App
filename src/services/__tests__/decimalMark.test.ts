/**
 * The decimal mark the phone writes numbers with, which its number pad types: on a phone, the one the
 * phone's own region settings give (expo-localization's decimalSeparator, the one the keyboard follows),
 * and in a browser, the one the browser writes 1.5 with. Anything but a comma is a point, and a phone or
 * browser that cannot say is taken to write a point, as the rule does with no mark given.
 */
type Native = typeof import('../decimalMark.native');
type Web = typeof import('../decimalMark');

const mockLocales = jest.fn<{ decimalSeparator: string | null }[], []>();
jest.mock('expo-localization', () => ({
  getLocales: () => mockLocales(),
  useLocales: () => mockLocales(),
}));

const native = (): Native => {
  let mod: Native | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual('../decimalMark.native.ts');
  });
  return mod!;
};
const web = (): Web => {
  let mod: Web | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual('../decimalMark.ts');
  });
  return mod!;
};

afterEach(() => {
  mockLocales.mockReset();
  jest.restoreAllMocks();
});

describe('on a phone', () => {
  it('is the decimal mark of the phone’s region settings', () => {
    mockLocales.mockReturnValue([{ decimalSeparator: ',' }, { decimalSeparator: '.' }]);
    expect(native().decimalMark()).toBe(',');
    mockLocales.mockReturnValue([{ decimalSeparator: '.' }]);
    expect(native().decimalMark()).toBe('.');
  });

  it('is a point when the phone gives none, or a mark the rule does not read', () => {
    for (const decimalSeparator of [null, '', '٫', '·']) {
      mockLocales.mockReturnValue([{ decimalSeparator }]);
      expect({ decimalSeparator, mark: native().decimalMark() }).toEqual({ decimalSeparator, mark: '.' });
    }
    mockLocales.mockReturnValue([]);
    expect(native().decimalMark()).toBe('.');
  });

  it('is a point when the phone cannot be asked', () => {
    mockLocales.mockImplementation(() => {
      throw new Error('no native module');
    });
    expect(native().decimalMark()).toBe('.');
  });
});

describe('in a browser', () => {
  const writes = (decimal: string) =>
    jest.spyOn(Intl, 'NumberFormat').mockImplementation(
      () => ({ formatToParts: () => [{ type: 'integer', value: '1' }, { type: 'decimal', value: decimal }, { type: 'fraction', value: '5' }] }) as unknown as Intl.NumberFormat,
    );

  it('is the decimal mark the browser writes 1.5 with', () => {
    writes(',');
    expect(web().decimalMark()).toBe(',');
    writes('.');
    expect(web().decimalMark()).toBe('.');
  });

  it('is a point for any other mark, or when the browser cannot say', () => {
    writes('٫');
    expect(web().decimalMark()).toBe('.');
    jest.spyOn(Intl, 'NumberFormat').mockImplementation(() => {
      throw new Error('no Intl');
    });
    expect(web().decimalMark()).toBe('.');
  });
});
