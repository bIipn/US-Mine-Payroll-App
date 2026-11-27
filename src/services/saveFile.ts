/**
 * Which way a file the app made went, for the toast that says so.
 * - `shared`: handed to the phone's share sheet (on an iPhone that sheet also has Save to Files, Print and a preview).
 * - `downloaded`: a browser's download.
 * - `opened`: opened in another app on the phone (Android: Open on this phone).
 * - `saved`: saved in a folder the person picked (Android: Save to phone).
 * - `closed`: the person closed the choices, and the file went nowhere.
 * - `failed`: it could not be handed over at all.
 */
export type FileWay = 'shared' | 'downloaded' | 'opened' | 'saved' | 'closed' | 'failed';

/** What a person can pick for a file on Android: open it, save it in a folder, or send it to another app. */
export type FileChoice = 'open' | 'save' | 'share';

/** What the choices are asked with: the file's name, whether an app on the phone opens it, and what just went wrong. */
export interface FileAsk {
  name: string;
  canOpen: boolean;
  note?: string;
}

/** Asks the person which way a file goes. `null`: they closed the choices. `useFileChoice` makes one for a screen. */
export type ChooseFileWay = (ask: FileAsk) => Promise<FileChoice | null>;

/**
 * Hand a generated file to the user — web build: a normal browser download.
 * The phone builds use saveFile.native.ts: the share sheet on an iPhone, and on Android a choice of
 * opening it, saving it to the phone or sending it to another app.
 */
export async function saveFile(name: string, bytes: Uint8Array, mime: string, _choose?: ChooseFileWay): Promise<FileWay> {
  try {
    const blob = new Blob([bytes as BlobPart], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}
