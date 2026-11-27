// Whether Clock in goes above the time card on the Clock screen: only when, with the card first, the whole
// button would not be on the screen without scrolling. The figures are what the Clock screen measures of
// itself on real phones, in dp, worked out from its own styles (a status bar of 24 dp on Android, 20 pt on the
// iPhone SE). Nothing here is anyone's.
const { clockInFirst } = require('../clock/clockLayout') as typeof import('../clock/clockLayout');

/**
 * The Clock screen off the clock, with no company logo: the coloured top down to the date line, the time card
 * (229), and the 76 dp Clock in button.
 */
const plain = (statusBar: number) => ({ top: statusBar + 12 + 44 + 54 + 90 + 24, card: 229, button: 76 });

describe('Clock in above the time card', () => {
  it('on a 360 x 640 dp Android phone with three-button navigation: the tab bar takes 114 dp of the 640', () => {
    expect(clockInFirst({ ...plain(24), room: 640 - 114 })).toBe(true);
  });

  it('on the same phone with gesture navigation, where the tab bar takes 90 dp', () => {
    expect(clockInFirst({ ...plain(24), room: 640 - 90 })).toBe(true);
  });

  it('not on a taller Android phone, 360 x 720 dp with three-button navigation', () => {
    expect(clockInFirst({ ...plain(24), room: 720 - 114 })).toBe(false);
  });

  it('not on the shortest iPhone, the SE (667 pt, a 72 pt tab bar), as before', () => {
    expect(clockInFirst({ ...plain(20), room: 667 - 72 })).toBe(false);
  });

  it('on the iPhone SE too once a company logo makes the coloured top about 60 pt taller', () => {
    expect(clockInFirst({ ...plain(20), top: plain(20).top + 60, room: 667 - 72 })).toBe(true);
  });

  it('on a phone set to a large font size, where the time card and the button are taller', () => {
    expect(clockInFirst({ top: plain(24).top * 1.3, card: 229 * 1.3, button: 76 * 1.3, room: 780 - 114 })).toBe(true);
  });

  it('only when the button would be cut off by more than half a dp: the button just fits', () => {
    const exactly = plain(24).top + 64 - 44 + 229 + 12 + 76;
    expect(clockInFirst({ ...plain(24), room: exactly })).toBe(false);
    expect(clockInFirst({ ...plain(24), room: exactly - 0.4 })).toBe(false);
    expect(clockInFirst({ ...plain(24), room: exactly - 1 })).toBe(true);
  });

  it('never before the screen has measured every part: the time card comes first, as it always has', () => {
    expect(clockInFirst({})).toBe(false);
    expect(clockInFirst({ room: 300 })).toBe(false);
    expect(clockInFirst({ room: 300, top: 248, card: 229 })).toBe(false);
    expect(clockInFirst({ room: 0, ...plain(24) })).toBe(false);
  });
});
