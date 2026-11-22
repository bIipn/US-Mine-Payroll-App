// The passcode a crew member signs in with: 6 to 12 digits, and not an easy one. A pure rule with no
// imports and only erasable TypeScript, so the server's SQL copy of it can be checked against this one
// under Node's type stripping.
export const PASSCODE_MIN = 6;
export const PASSCODE_MAX = 12;

// The most common 6-digit passcodes in published PIN studies.
export const EASY_PASSCODES: readonly string[] = [
  '123456', '111111', '000000', '121212', '654321', '666666', '112233', '123123', '159753',
  '147258', '696969', '520520', '789456', '101010', '102030', '123654', '456789', '987654',
];

export type PasscodeProblem = 'not_digits' | 'too_short' | 'too_long' | 'easy';

// Every digit one more (or one less) than the last.
function isRun(p: string): boolean {
  for (const step of [1, -1]) {
    let all = true;
    for (let i = 1; i < p.length; i++) if (Number(p[i]) - Number(p[i - 1]) !== step) all = false;
    if (all) return true;
  }
  return false;
}

// The whole passcode a 2- or 3-digit block repeated.
function isRepeatedBlock(p: string): boolean {
  for (const size of [1, 2, 3]) {
    if (p.length % size === 0 && p.length / size >= 2 && p.slice(0, size).repeat(p.length / size) === p) return true;
  }
  return false;
}

// Three or more doubled digits counting up, like 112233.
function isDoubledRun(p: string): boolean {
  if (p.length % 2 !== 0 || p.length < 6) return false;
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] !== p[i + 1]) return false;
    if (i > 0 && Number(p[i]) - Number(p[i - 2]) !== 1) return false;
  }
  return true;
}

function isPalindrome(p: string): boolean {
  return p.split('').reverse().join('') === p;
}

export function passcodeProblem(passcode: string): PasscodeProblem | null {
  if (!/^[0-9]+$/.test(passcode)) return 'not_digits';
  if (passcode.length < PASSCODE_MIN) return 'too_short';
  if (passcode.length > PASSCODE_MAX) return 'too_long';
  if (
    EASY_PASSCODES.includes(passcode) ||
    isRun(passcode) ||
    isRepeatedBlock(passcode) ||
    isDoubledRun(passcode) ||
    isPalindrome(passcode)
  )
    return 'easy';
  return null;
}

export function passcodeWords(problem: PasscodeProblem): string {
  switch (problem) {
    case 'not_digits':
      return 'Use only digits.';
    case 'too_short':
      return `Use at least ${PASSCODE_MIN} digits.`;
    case 'too_long':
      return `Use at most ${PASSCODE_MAX} digits.`;
    case 'easy':
      return `That passcode is too easy to guess. Pick ${PASSCODE_MIN} digits that are not a pattern.`;
  }
}
