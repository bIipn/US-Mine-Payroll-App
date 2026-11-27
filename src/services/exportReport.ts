import { useStore } from '../store/useStore';
import { haptic } from './haptics';
import type { PdfReport } from './inspectorReport';
import type { CsvFile, Report } from './reports';
import { saveFile, type ChooseFileWay, type FileWay } from './saveFile';
import { XLSX_MIME } from './xlsx';

export const PDF_MIME = 'application/pdf';

/** Hand the file over, and say which way it went; a save that throws counts as one that failed. */
const handOver = (name: string, bytes: Uint8Array, mime: string, choose?: ChooseFileWay): Promise<FileWay> =>
  saveFile(name, bytes, mime, choose).catch(() => 'failed' as const);

/** What a file that went somewhere did, in the toast: ready (share sheet or download), opened, or saved. */
const WENT: Record<'shared' | 'downloaded' | 'opened' | 'saved', string> = {
  shared: 'ready',
  downloaded: 'ready',
  opened: 'opened',
  saved: 'saved in the folder you picked',
};

/** A name as it starts a sentence: "payroll hours file" is "Payroll hours file"; "PDF" stays as it is. */
const opening = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * Tell the person which way the file went. `what` names the file as it reads in the middle of a sentence
 * ("PDF", "Excel file", "payroll hours file"), and takes a capital where it starts one. `detail` says what
 * is in it, and `none` is said instead when there is nothing in it.
 */
function tellWay(way: FileWay, what: string, detail: string | null, none?: string) {
  const { showToast } = useStore.getState();
  if (way === 'closed') {
    showToast(`The ${what} was not saved or sent.`, 'info');
  } else if (way === 'failed') {
    haptic.error();
    showToast('The file was built but could not be saved on this device.', 'bo');
  } else {
    haptic.success();
    const head = `${opening(what)} ${WENT[way]}`;
    showToast(detail ? `${head}: ${detail}` : none ? `${head}. ${none}` : head);
  }
}

/**
 * Build an Excel report and hand it over: the share sheet on an iPhone, the choices of `choose` on Android
 * (open it, save it to the phone, or send it to another app), a download in a browser.
 */
export async function exportReport(build: () => Report, choose?: ChooseFileWay): Promise<void> {
  let report: Report;
  try {
    report = build();
  } catch {
    haptic.error();
    useStore.getState().showToast('The Excel file could not be built. Try a shorter date range.', 'bo');
    return;
  }
  tellWay(await handOver(report.name, report.bytes, XLSX_MIME, choose), 'Excel file', `${report.sheets} sheets, ${report.rows} rows`);
}

/** Build a PDF and hand it over the same way. */
export async function exportPdf(build: () => PdfReport, choose?: ChooseFileWay): Promise<void> {
  let report: PdfReport;
  try {
    report = build();
  } catch {
    haptic.error();
    useStore.getState().showToast('The PDF could not be built. Try a shorter date range.', 'bo');
    return;
  }
  tellWay(await handOver(report.name, report.bytes, PDF_MIME, choose), 'PDF', `${report.pages} ${report.pages === 1 ? 'page' : 'pages'}`);
}

/** Build a CSV and hand it over the same way. */
export async function exportCsv(build: () => CsvFile, choose?: ChooseFileWay): Promise<void> {
  let file: CsvFile;
  try {
    file = build();
  } catch {
    haptic.error();
    useStore.getState().showToast('The payroll hours file could not be built. Try a shorter date range.', 'bo');
    return;
  }
  const lines = file.lines ? `${file.lines} ${file.lines === 1 ? 'line' : 'lines'}` : null;
  tellWay(await handOver(file.name, file.bytes, 'text/csv', choose), 'payroll hours file', lines, 'No hours in this period.');
}
