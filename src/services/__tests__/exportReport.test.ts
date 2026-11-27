/**
 * The toast after an export says which way the file went: ready (handed to the share sheet, or a browser's
 * download, as it always said), opened on this phone, or saved in the folder the person picked. Closing the
 * choices says nothing went anywhere, and a file that could not be handed over says so. The screen's way of
 * asking (Android) goes through to the phone's save. The phone's save is a stand-in here.
 */
import type { ChooseFileWay, FileWay } from '../saveFile';

const mockSaveFile = jest.fn<Promise<FileWay>, [string, Uint8Array, string, ChooseFileWay?]>();
const mockShowToast = jest.fn();
const mockSuccess = jest.fn();
const mockError = jest.fn();
jest.mock('../saveFile', () => ({ saveFile: (...args: Parameters<typeof mockSaveFile>) => mockSaveFile(...args) }));
jest.mock('../haptics', () => ({ haptic: { success: () => mockSuccess(), error: () => mockError() } }));
jest.mock('../../store/useStore', () => ({ useStore: { getState: () => ({ showToast: mockShowToast }) } }));

const { exportCsv, exportPdf, exportReport, PDF_MIME } = require('../exportReport') as typeof import('../exportReport');
const { XLSX_MIME } = require('../xlsx') as typeof import('../xlsx');

const BYTES = new Uint8Array([1, 2, 3]);
const pdf = () => ({ name: 'inspector.pdf', bytes: BYTES, pages: 3 });
const excel = () => ({ name: 'payroll.xlsx', bytes: BYTES, sheets: 4, rows: 120 });
const csv = (lines: number) => () => ({ name: 'hours.csv', bytes: BYTES, lines });
const choose: ChooseFileWay = async () => null;

beforeEach(() => {
  mockSaveFile.mockReset();
  mockShowToast.mockReset();
  mockSuccess.mockReset();
  mockError.mockReset();
});

const toast = () => mockShowToast.mock.calls[0] as [string, string?];

describe('the toast says which way the file went', () => {
  it('hands the screen’s way of asking to the save, with the file’s type', async () => {
    mockSaveFile.mockResolvedValue('shared');
    await exportPdf(pdf, choose);
    expect(mockSaveFile).toHaveBeenCalledWith('inspector.pdf', BYTES, PDF_MIME, choose);
    await exportReport(excel, choose);
    expect(mockSaveFile).toHaveBeenLastCalledWith('payroll.xlsx', BYTES, XLSX_MIME, choose);
    await exportCsv(csv(2), choose);
    expect(mockSaveFile).toHaveBeenLastCalledWith('hours.csv', BYTES, 'text/csv', choose);
  });

  it('says ready, as before, when the file went to the share sheet or a download', async () => {
    mockSaveFile.mockResolvedValue('shared');
    await exportPdf(pdf);
    expect(toast()).toEqual(['PDF ready: 3 pages']);
    expect(mockSuccess).toHaveBeenCalledTimes(1);

    mockShowToast.mockReset();
    mockSaveFile.mockResolvedValue('downloaded');
    await exportReport(excel);
    expect(toast()).toEqual(['Excel file ready: 4 sheets, 120 rows']);

    mockShowToast.mockReset();
    await exportCsv(csv(1));
    expect(toast()).toEqual(['Payroll hours file ready: 1 line']);

    mockShowToast.mockReset();
    await exportCsv(csv(0));
    expect(toast()).toEqual(['Payroll hours file ready. No hours in this period.']);
  });

  it('says opened when it was opened on this phone', async () => {
    mockSaveFile.mockResolvedValue('opened');
    await exportPdf(pdf, choose);
    expect(toast()).toEqual(['PDF opened: 3 pages']);
    expect(mockSuccess).toHaveBeenCalledTimes(1);

    mockShowToast.mockReset();
    await exportCsv(csv(0), choose);
    expect(toast()).toEqual(['Payroll hours file opened. No hours in this period.']);
  });

  it('says saved in the folder the person picked', async () => {
    mockSaveFile.mockResolvedValue('saved');
    await exportReport(excel, choose);
    expect(toast()).toEqual(['Excel file saved in the folder you picked: 4 sheets, 120 rows']);
    expect(mockSuccess).toHaveBeenCalledTimes(1);

    mockShowToast.mockReset();
    await exportCsv(csv(12), choose);
    expect(toast()).toEqual(['Payroll hours file saved in the folder you picked: 12 lines']);
  });

  it('says nothing went anywhere when the person closed the choices, with no buzz', async () => {
    mockSaveFile.mockResolvedValue('closed');
    await exportPdf(pdf, choose);
    expect(toast()).toEqual(['The PDF was not saved or sent.', 'info']);
    expect(mockSuccess).not.toHaveBeenCalled();
    expect(mockError).not.toHaveBeenCalled();
  });

  it('says it could not be handed over, as before, when it failed', async () => {
    mockSaveFile.mockResolvedValue('failed');
    await exportReport(excel, choose);
    expect(toast()).toEqual(['The file was built but could not be saved on this device.', 'bo']);
    expect(mockError).toHaveBeenCalledTimes(1);
  });

  it('says the file could not be built when building it fails, and asks nothing', async () => {
    await exportPdf(() => {
      throw new Error('too big');
    }, choose);
    expect(mockSaveFile).not.toHaveBeenCalled();
    expect(toast()).toEqual(['The PDF could not be built. Try a shorter date range.', 'bo']);
  });
});
