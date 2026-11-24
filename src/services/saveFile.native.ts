import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * Hand a generated file to the user — iPhone and Android: write it to the app
 * cache and open the share sheet (Save to Files, email, OneDrive, AirDrop...).
 */
export async function saveFile(name: string, bytes: Uint8Array, mime: string): Promise<boolean> {
  try {
    const file = new File(Paths.cache, name);
    if (file.exists) file.delete();
    file.create();
    await file.write(bytes);
    if (!(await Sharing.isAvailableAsync())) return false;
    await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle: name });
    return true;
  } catch {
    return false;
  }
}
