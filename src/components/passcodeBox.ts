import { PASSCODE_MAX } from '../domain/passcode';

/**
 * A passcode box's settings, for a Field: the number pad, hidden as it is typed, nothing a keyboard or a
 * password manager fills in, and no more digits than a passcode has. Crew sign-in and Delete my account
 * both type a passcode in one.
 */
export const PASSCODE_BOX = { keyboardType: 'number-pad', secureTextEntry: true, autoComplete: 'off', autoCorrect: false, maxLength: PASSCODE_MAX } as const;
