/**
 * Visual language for US Mine Crew.
 *
 * The palette is taken from the mine itself: equipment yellow, the black
 * ilmenite sand and white kaolin clay the Ione plant produces, the red
 * iron-oxide soil of the Ione Formation, and the settling ponds.
 * Type is Barlow, the family drawn from California highway signs and plates;
 * the condensed cut carries numerals, unit numbers and headings.
 */

export const color = {
  /** Equipment yellow: the action colour, and the whole screen when you are on the clock. */
  yellow: '#FFC400',
  yellowDeep: '#E0AB00',
  yellowTint: '#FFF1BF',
  /** Ilmenite: text and the off-the-clock field. */
  ink: '#1C1B19',
  inkSoft: '#34322E',
  /** Kaolin: page background. */
  kaolin: '#EEF0EC',
  paper: '#FFFFFF',
  /** Ione red: Bad Order, tag-out, overdue. */
  red: '#B5341F',
  redTint: '#F8E4DF',
  /** Bench green: OK, on site. */
  green: '#1E7A46',
  greenTint: '#DFF0E5',
  /** Pond blue: lunch, information. */
  blue: '#1F5F8B',
  blueTint: '#DDEAF2',
  /** Amber: a deadline is getting close. */
  amber: '#8A5300',
  amberTint: '#FFE9BF',
  /** Silica: secondary text. */
  silica: '#62665F',
  silicaLight: '#9A9E96',
  rule: '#D6D9D1',
  grayTint: '#E4E6E0',
  white: '#FFFFFF',
  onDarkMuted: '#B9BBB4',
} as const;

export const font = {
  body: 'Barlow_500Medium',
  bodySemi: 'Barlow_600SemiBold',
  bodyBold: 'Barlow_700Bold',
  cond: 'BarlowCondensed_600SemiBold',
  condBold: 'BarlowCondensed_700Bold',
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, xxxl: 40 } as const;

export const radius = { sm: 6, md: 12, lg: 16 } as const;

/** Smallest thing a gloved thumb is asked to hit. */
export const TAP = 56;

export type Tone = 'neutral' | 'ok' | 'bo' | 'warn' | 'info' | 'yellow' | 'ink';

export const toneColor: Record<Tone, { bg: string; fg: string; solid: string; onSolid: string }> = {
  neutral: { bg: color.grayTint, fg: color.inkSoft, solid: color.silica, onSolid: color.white },
  ok: { bg: color.greenTint, fg: color.green, solid: color.green, onSolid: color.white },
  bo: { bg: color.redTint, fg: color.red, solid: color.red, onSolid: color.white },
  warn: { bg: color.amberTint, fg: color.amber, solid: color.amber, onSolid: color.white },
  info: { bg: color.blueTint, fg: color.blue, solid: color.blue, onSolid: color.white },
  yellow: { bg: color.yellowTint, fg: color.ink, solid: color.yellow, onSolid: color.ink },
  ink: { bg: color.grayTint, fg: color.ink, solid: color.ink, onSolid: color.white },
};
