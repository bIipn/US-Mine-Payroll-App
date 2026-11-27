import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import type { ChooseFileWay, FileAsk, FileWay } from './saveFile';

/** What the choices say when a step did not work, so the person knows what to try next. */
const NOT_OPENED = 'It could not be opened on this phone. Save it to the phone or send it to another app.';
const NO_PICKER = 'This phone could not open a folder to save it in. Send it to another app instead.';
const NOT_IN_FOLDER = 'It could not be saved in that folder. Pick another folder, or make a new one.';

/**
 * Hand a generated file to the user. It is written to the app's cache first.
 *
 * iPhone: the share sheet, which also has Save to Files, Print and a preview.
 *
 * Android: the share sheet only sends a file to another app, and the file would stay in the app's cache. So
 * `choose` asks first: Open on this phone (offered when an app on the phone opens the type, and handed to it
 * with a read grant), Save to phone (a copy in a folder the person picks; Android 11 and later will not let a
 * person pick Download itself, only a folder in it), or Send to another app (the share sheet). Backing out of
 * the folder picker, or a step that fails, comes back to the choices. With no `choose`, the share sheet.
 *
 * Says which way the file went, for the toast.
 */
export async function saveFile(name: string, bytes: Uint8Array, mime: string, choose?: ChooseFileWay): Promise<FileWay> {
  let file: File;
  try {
    file = new File(Paths.cache, name);
    if (file.exists) file.delete();
    file.create();
    await file.write(bytes);
  } catch {
    return 'failed';
  }
  if (Platform.OS !== 'android' || !choose) return share(file, name, mime);

  let canOpen = false;
  try {
    canOpen = await file.canPreview({ mimeType: mime });
  } catch {
    // The phone cannot say whether an app opens it: the choice is left out rather than offered and failing.
  }
  let note: string | undefined;
  for (;;) {
    const ask: FileAsk = { name, canOpen };
    if (note) ask.note = note;
    const pick = await choose(ask);
    note = undefined;
    if (pick == null) return 'closed';
    if (pick === 'share') return share(file, name, mime);
    if (pick === 'open') {
      try {
        await file.preview({ mimeType: mime });
        return 'opened';
      } catch {
        canOpen = false;
        note = NOT_OPENED;
        continue;
      }
    }
    let folder: Directory;
    try {
      folder = await Directory.pickDirectoryAsync();
    } catch (e) {
      // Backing out of the picker is the person's own choice: the choices come back as they were.
      if ((e as { code?: string } | null)?.code !== 'ERR_PICKER_CANCELLED') note = NO_PICKER;
      continue;
    }
    try {
      await folder.createFile(name, mime).write(bytes);
      return 'saved';
    } catch {
      note = NOT_IN_FOLDER;
    }
  }
}

async function share(file: File, name: string, mime: string): Promise<FileWay> {
  try {
    if (!(await Sharing.isAvailableAsync())) return 'failed';
    await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: name });
    return 'shared';
  } catch {
    return 'failed';
  }
}
