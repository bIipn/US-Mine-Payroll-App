// Delete my account is in every build, because an account kept on the phone alone is deleted there too
// (Apple 5.1.1(v)), and the public preview must not grow by the server code (AGENTS.md). So the screen
// reaches the server only through src/services/connection.ts, and these hold that, and that the way in
// is where people look: More, Company account, and the sign-in screens for someone taken off the roster.
// What the screen does, for a passcode sign-in and from the company sign-in screen, is in
// companyAccount.test.tsx.

// This project has no Node types, so the file system is asked for by name with the calls used here.
const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');
const here = expect.getState().testPath ?? '';
const root = here.slice(0, here.search(/[\\/]src[\\/]/));
const source = (file: string) => fs.readFileSync(`${root}/src/${file}`, 'utf8');
const imports = (text: string) => [...text.matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);

describe('Delete my account', () => {
  it('imports nothing of the server but connection.ts, so a build with no server carries none of it', () => {
    for (const file of ['screens/more/DeleteAccountScreen.tsx', 'domain/accountDeletion.ts', 'screens/more/MoreScreen.tsx', 'screens/more/SignOutOfPhone.tsx', 'screens/auth/AuthScreen.tsx']) {
      const from = imports(source(file));
      expect({ file, server: from.filter((m) => /services\/server$|serverAnswers$|@supabase\//.test(m)) }).toEqual({ file, server: [] });
    }
    // connection.ts takes the words it needs from the shared module, never from serverAnswers.ts.
    expect(imports(source('services/connection.ts')).filter((m) => /serverAnswers|@supabase\//.test(m))).toEqual([]);
  });

  it('keeps the shared module free of React Native and Expo, for the office dashboard', () => {
    for (const m of imports(source('domain/accountDeletion.ts'))) expect(m.startsWith('./')).toBe(true);
  });

  it('is a route in every build, opened from More, from Company account, and from the sign-in screens', () => {
    const navigator = source('navigation/RootNavigator.tsx');
    expect(navigator).toMatch(/^\s*<Stack\.Screen name="DeleteAccount" component=\{DeleteAccountScreen\} \/>$/m);
    expect(source('screens/more/MoreScreen.tsx')).toMatch(/navigation\.navigate\('DeleteAccount'\)/);
    // On a phone joined with the person's own sign-in, the whole account.
    expect(source('screens/more/CompanyAccountScreen.tsx')).toMatch(/label="Delete my account"[^\n]*navigate\('DeleteAccount'\)/);
    expect(source('screens/more/CompanyAccountScreen.tsx')).not.toMatch(/signInOnly/);
    // The company sign-in screen: someone taken off the roster, and an email sign-in on no company's roster, which goes alone.
    const companySignIn = source('screens/auth/CompanySignInScreen.tsx');
    expect(companySignIn).toMatch(/navigation\.navigate\('DeleteAccount'\)/);
    expect(companySignIn).toMatch(/navigation\.navigate\('DeleteAccount', \{ signInOnly: true \}\)/);
    // A build with no server: the account kept on the phone, with its password.
    expect(source('screens/auth/AuthScreen.tsx')).toMatch(/deleteAccountWithPassword\(email, password\)/);
  });
});
