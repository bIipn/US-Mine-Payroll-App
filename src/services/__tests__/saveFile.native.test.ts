/**
 * Where an export goes on a phone. An iPhone's share sheet has Save to Files, Print and a preview of its own, so
 * on an iPhone the file goes to the share sheet and nowhere else, as it always has. Android's share sheet only
 * sends the file to another app, so on Android the app asks first: open it on this phone (when an app on the
 * phone can), save it in a folder the person picks, or send it to another app. Backing out of the folder picker,
 * or a step that fails, comes back to the choices. Which way the file went comes back for the toast.
 *
 * The phone is made up here: its files, its viewers, its folder picker and its share sheet are stand-ins.
 */
import type { ChooseFileWay, FileAsk, FileChoice } from '../saveFile';

type Os = 'android' | 'ios';
const PDF = 'application/pdf';
const BYTES = new Uint8Array([37, 80, 68, 70]);

interface Phone {
  /** Whether an app on the phone opens a file of this type. */
  canOpen?: boolean;
  /** The app that opens it goes away as the file is handed to it. */
  openFails?: boolean;
  /** What each turn of the folder picker comes to, in order: a folder, backed out, or a picker that fails. */
  picks?: ('folder' | 'cancel' | 'broken')[];
  /** The picked folder takes no file. */
  folderFails?: boolean;
  /** The app's own cache takes no file. */
  cacheFails?: boolean;
  /** The phone has no share sheet. */
  noShareSheet?: boolean;
}

function load(os: Os, phone: Phone = {}) {
  const canPreview = jest.fn(async (_file: string, _options: unknown) => phone.canOpen ?? true);
  const preview = jest.fn(async (_file: string, _options: unknown) => {
    if (phone.openFails) throw new Error("No app can preview files of type 'application/pdf'.");
  });
  const written: Record<string, Uint8Array> = {};
  const createFile = jest.fn((name: string, _mime: string | null) => {
    const uri = `content://tree/Reports/${name}`;
    return {
      uri,
      write: jest.fn(async (bytes: Uint8Array) => {
        if (phone.folderFails) throw new Error('could not write');
        written[uri] = bytes;
      }),
    };
  });
  const picks = [...(phone.picks ?? ['folder'])];
  const pickDirectoryAsync = jest.fn(async () => {
    const pick = picks.shift() ?? 'cancel';
    if (pick === 'cancel') throw Object.assign(new Error('The file picker was cancelled by the user'), { code: 'ERR_PICKER_CANCELLED' });
    if (pick === 'broken') throw Object.assign(new Error('No activity found'), { code: 'ERR_UNEXPECTED' });
    return { uri: 'content://tree/Reports', createFile };
  });

  class File {
    uri: string;
    exists = false;
    constructor(dir: { uri: string }, name: string) {
      this.uri = `${dir.uri}${name}`;
    }
    delete() {
      this.exists = false;
    }
    create() {
      this.exists = true;
    }
    async write(bytes: Uint8Array) {
      if (phone.cacheFails) throw new Error('disk full');
      written[this.uri] = bytes;
    }
    canPreview(options: unknown) {
      return canPreview(this.uri, options);
    }
    preview(options: unknown) {
      return preview(this.uri, options);
    }
  }
  const sharing = {
    isAvailableAsync: jest.fn(async () => !phone.noShareSheet),
    shareAsync: jest.fn(async (_uri: string, _options: unknown) => undefined),
  };

  let mod: typeof import('../saveFile.native') | undefined;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: os } }));
    jest.doMock('expo-file-system', () => ({ File, Directory: { pickDirectoryAsync }, Paths: { cache: { uri: 'file:///cache/' } } }));
    jest.doMock('expo-sharing', () => sharing);
    mod = require('../saveFile.native');
  });
  return { saveFile: mod!.saveFile, canPreview, preview, pickDirectoryAsync, createFile, sharing, written };
}

/** The person's answers to the choices, in order; a closed sheet once they run out. */
function person(...answers: (FileChoice | null)[]) {
  const asked: FileAsk[] = [];
  const choose: jest.MockedFunction<ChooseFileWay> = jest.fn(async (ask: FileAsk) => {
    asked.push(ask);
    return answers.length ? answers.shift()! : null;
  });
  return { choose, asked };
}

const CACHED = 'file:///cache/inspector.pdf';

describe('on an iPhone', () => {
  it('hands the file to the share sheet with its type, and asks nothing', async () => {
    const phone = load('ios');
    const { choose } = person('open');
    await expect(phone.saveFile('inspector.pdf', BYTES, PDF, choose)).resolves.toBe('shared');
    expect(phone.written[CACHED]).toBe(BYTES);
    expect(phone.sharing.shareAsync).toHaveBeenCalledWith(CACHED, { mimeType: PDF, dialogTitle: 'inspector.pdf' });
    expect(choose).not.toHaveBeenCalled();
    expect(phone.canPreview).not.toHaveBeenCalled();
    expect(phone.preview).not.toHaveBeenCalled();
    expect(phone.pickDirectoryAsync).not.toHaveBeenCalled();
  });

  it('says it failed when the phone has no share sheet', async () => {
    const phone = load('ios', { noShareSheet: true });
    await expect(phone.saveFile('inspector.pdf', BYTES, PDF)).resolves.toBe('failed');
  });
});

describe('on Android', () => {
  it('asks which way, offering Open on this phone when an app can open the type', async () => {
    const phone = load('android');
    const { choose, asked } = person('open');
    await expect(phone.saveFile('inspector.pdf', BYTES, PDF, choose)).resolves.toBe('opened');
    expect(phone.canPreview).toHaveBeenCalledWith(CACHED, { mimeType: PDF });
    expect(asked).toEqual([{ name: 'inspector.pdf', canOpen: true }]);
    expect(phone.preview).toHaveBeenCalledWith(CACHED, { mimeType: PDF });
    expect(phone.sharing.shareAsync).not.toHaveBeenCalled();
  });

  it('leaves Open on this phone out when no app on the phone opens the type', async () => {
    const phone = load('android', { canOpen: false });
    const { choose, asked } = person('share');
    await expect(phone.saveFile('hours.csv', BYTES, 'text/csv', choose)).resolves.toBe('shared');
    expect(phone.canPreview).toHaveBeenCalledWith('file:///cache/hours.csv', { mimeType: 'text/csv' });
    expect(asked[0]?.canOpen).toBe(false);
    expect(phone.preview).not.toHaveBeenCalled();
  });

  it('saves a copy in the folder the person picks, made with the file type', async () => {
    const phone = load('android');
    const { choose } = person('save');
    await expect(phone.saveFile('inspector.pdf', BYTES, PDF, choose)).resolves.toBe('saved');
    expect(phone.pickDirectoryAsync).toHaveBeenCalledTimes(1);
    expect(phone.createFile).toHaveBeenCalledWith('inspector.pdf', PDF);
    expect(phone.written['content://tree/Reports/inspector.pdf']).toBe(BYTES);
    expect(phone.sharing.shareAsync).not.toHaveBeenCalled();
  });

  it('keeps the share sheet as one of the choices', async () => {
    const phone = load('android');
    const { choose } = person('share');
    await expect(phone.saveFile('inspector.pdf', BYTES, PDF, choose)).resolves.toBe('shared');
    expect(phone.sharing.shareAsync).toHaveBeenCalledWith(CACHED, { mimeType: PDF, dialogTitle: 'inspector.pdf' });
  });

  it('comes back to the choices when the person backs out of the folder picker', async () => {
    const phone = load('android', { picks: ['cancel', 'folder'] });
    const { choose, asked } = person('save', 'save');
    await expect(phone.saveFile('inspector.pdf', BYTES, PDF, choose)).resolves.toBe('saved');
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual({ name: 'inspector.pdf', canOpen: true });
  });

  it('says so, and asks again, when the folder picker will not open', async () => {
    const phone = load('android', { picks: ['broken'] });
    const { choose, asked } = person('save', 'share');
    await expect(phone.saveFile('inspector.pdf', BYTES, PDF, choose)).resolves.toBe('shared');
    expect(asked[1]?.note).toMatch(/could not open a folder/i);
  });

  it('says so, and asks again, when the picked folder takes no file', async () => {
    const phone = load('android', { folderFails: true });
    const { choose, asked } = person('save', null);
    await expect(phone.saveFile('inspector.pdf', BYTES, PDF, choose)).resolves.toBe('closed');
    expect(asked[1]?.note).toMatch(/could not be saved in that folder/i);
  });

  it('says so, and asks again without Open on this phone, when the app that opens it fails', async () => {
    const phone = load('android', { openFails: true });
    const { choose, asked } = person('open', 'save');
    await expect(phone.saveFile('inspector.pdf', BYTES, PDF, choose)).resolves.toBe('saved');
    expect(asked[1]?.canOpen).toBe(false);
    expect(asked[1]?.note).toMatch(/could not be opened/i);
  });

  it('sends the file nowhere when the person closes the choices', async () => {
    const phone = load('android');
    const { choose } = person(null);
    await expect(phone.saveFile('inspector.pdf', BYTES, PDF, choose)).resolves.toBe('closed');
    expect(phone.sharing.shareAsync).not.toHaveBeenCalled();
    expect(phone.preview).not.toHaveBeenCalled();
    expect(phone.pickDirectoryAsync).not.toHaveBeenCalled();
  });

  it('asks with Open on this phone left out when the phone cannot say whether an app opens it', async () => {
    const phone = load('android');
    phone.canPreview.mockRejectedValueOnce(new Error('cannot read'));
    const { choose, asked } = person(null);
    await phone.saveFile('inspector.pdf', BYTES, PDF, choose);
    expect(asked[0]?.canOpen).toBe(false);
  });

  it('goes straight to the share sheet when nothing on the screen can ask', async () => {
    const phone = load('android');
    await expect(phone.saveFile('inspector.pdf', BYTES, PDF)).resolves.toBe('shared');
    expect(phone.sharing.shareAsync).toHaveBeenCalledTimes(1);
  });

  it('says it failed, and asks nothing, when the file cannot be written at all', async () => {
    const phone = load('android', { cacheFails: true });
    const { choose } = person('open');
    await expect(phone.saveFile('inspector.pdf', BYTES, PDF, choose)).resolves.toBe('failed');
    expect(choose).not.toHaveBeenCalled();
  });
});
