import { space } from '../../theme/theme';

/** How far the time card reaches up over the coloured top of the Clock screen. */
export const CARD_REACH = 44;

/**
 * The coloured top's own room under the date line: for the time card to reach up into, or, with Clock in
 * above the card, the top's ordinary padding.
 */
export const FIELD_FOOT = { card: 64, button: space.xl } as const;

/** Between one thing and the next under the coloured top (the screen's own gap). */
const GAP = space.md;

/** What the Clock screen measures of itself as the phone lays it out, in dp. */
export interface ClockMeasures {
  /**
   * The height the screen has to show things in without scrolling: above the tab bar, or, with no tab bar,
   * above the phone's own navigation bar.
   */
  room: number;
  /** The coloured top down to the foot of its date line, its own room under that left out. */
  top: number;
  /** The time card. */
  card: number;
  /** The Clock in button. */
  button: number;
}

/**
 * Whether Clock in goes above the time card: only when, with the card first, the whole button would not be
 * on the screen without scrolling. That is a short phone with three-button navigation, a company logo, or a
 * large font or display size; on the shortest iPhone with no logo it fits. Until every part is measured, the
 * card comes first. Each part measures the same whichever comes first, so the choice does not go back and
 * forth as the screen is laid out again.
 */
export function clockInFirst(m: Partial<ClockMeasures>): boolean {
  const { room, top, card, button } = m;
  if (room == null || top == null || card == null || button == null || room <= 0) return false;
  const buttonFoot = top + FIELD_FOOT.card - CARD_REACH + card + GAP + button;
  return buttonFoot > room + 0.5;
}
