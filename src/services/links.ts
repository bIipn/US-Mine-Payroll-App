import { Linking } from 'react-native';

/** Open one of MineMuster's web pages (`WEB_PAGES`) in the phone's browser. False when the phone could not open it. */
export async function openWebPage(url: string): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
