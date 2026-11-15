import { Eye, EyeOff, HardHat, ShieldCheck } from '../../components/icons';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LogoPlate, ProviderMark } from '../../components/Brand';
import { Button, Divider, Field, IconButton, Row, Segmented, Sheet, Txt } from '../../components/ui';
import { DEMO_MODE, SITE_LABEL } from '../../config';
import type { AuthProvider, Role } from '../../domain/types';
import { haptic } from '../../services/haptics';
import { useStore } from '../../store/useStore';
import { color, font, radius, space } from '../../theme/theme';

type Mode = 'signin' | 'signup';
type Provider = Exclude<AuthProvider, 'password'>;

const PROVIDERS: { id: Provider; name: string }[] = [
  { id: 'apple', name: 'Apple' },
  { id: 'google', name: 'Google' },
  { id: 'microsoft', name: 'Microsoft' },
];

export function AuthScreen() {
  const insets = useSafeAreaInsets();
  const signIn = useStore((s) => s.signIn);
  const signUp = useStore((s) => s.signUp);
  const signInWithProvider = useStore((s) => s.signInWithProvider);
  const signInDemo = useStore((s) => s.signInDemo);
  const showToast = useStore((s) => s.showToast);

  const [mode, setMode] = useState<Mode>('signin');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [provider, setProvider] = useState<Provider | null>(null);
  const [providerFirst, setProviderFirst] = useState('');
  const [providerLast, setProviderLast] = useState('');
  const [providerError, setProviderError] = useState<string | null>(null);

  const submit = () => {
    const result = mode === 'signin' ? signIn(email, password) : signUp({ firstName, lastName, email, password });
    if (result.ok) {
      haptic.success();
      if (mode === 'signup') showToast('Account created. You are signed in.');
    } else {
      haptic.error();
      setError(result.error);
    }
  };

  const continueWithProvider = () => {
    if (!provider) return;
    const result = signInWithProvider(provider, providerFirst, providerLast);
    if (result.ok) {
      haptic.success();
      setProvider(null);
    } else {
      haptic.error();
      setProviderError(result.error);
    }
  };

  const demo = (role: Role) => {
    const result = signInDemo(role);
    if (!result.ok) showToast(result.error, 'bo');
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        testID="auth-screen"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xxl }}
      >
        <View style={[styles.field, { paddingTop: insets.top + space.xxl }]}>
          <LogoPlate width={264} radius={10} />
          <Txt v="h1" c={color.white} style={{ marginTop: space.xl }}>
            Clock in. Check your machine. Get paid right.
          </Txt>
          <Txt v="body" c={color.onDarkMuted} style={{ marginTop: space.sm }}>
            Time, checklists and maintenance requests for the crew at {SITE_LABEL}.
          </Txt>
        </View>

        <View style={styles.form}>
          <Segmented
            testID="auth-mode"
            value={mode}
            onChange={(next) => {
              setMode(next);
              setError(null);
            }}
            options={[
              { value: 'signin', label: 'Sign in' },
              { value: 'signup', label: 'Create account' },
            ]}
          />

          {mode === 'signup' ? (
            <View style={styles.nameRow}>
              <View style={{ flex: 1 }}>
                <Field testID="first-name" label="First name" value={firstName} onChangeText={setFirstName} autoCapitalize="words" autoComplete="given-name" />
              </View>
              <View style={{ flex: 1 }}>
                <Field testID="last-name" label="Last name" value={lastName} onChangeText={setLastName} autoCapitalize="words" autoComplete="family-name" />
              </View>
            </View>
          ) : null}

          <Field
            testID="email"
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
          />
          <Field
            testID="password"
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            hint={mode === 'signup' ? 'At least 8 characters.' : undefined}
            onSubmitEditing={submit}
            right={
              <IconButton
                icon={showPassword ? EyeOff : Eye}
                label={showPassword ? 'Hide password' : 'Show password'}
                onPress={() => setShowPassword((v) => !v)}
                tint={color.silica}
              />
            }
          />

          {error ? (
            <View style={styles.error} accessibilityLiveRegion="polite">
              <Txt v="smallStrong" c={color.red} testID="auth-error">{error}</Txt>
            </View>
          ) : null}

          <Button
            testID="auth-submit"
            label={mode === 'signin' ? 'Sign in' : 'Create account'}
            size="lg"
            kind="yellow"
            onPress={submit}
          />

          <View style={styles.or}>
            <View style={styles.orLine} />
            <Txt v="small" c={color.silica}>or</Txt>
            <View style={styles.orLine} />
          </View>

          {PROVIDERS.map((p) => (
            <Pressable
              key={p.id}
              testID={`provider-${p.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Continue with ${p.name}`}
              onPress={() => {
                haptic.tap();
                setProviderError(null);
                setProvider(p.id);
              }}
              style={({ pressed }) => [styles.provider, p.id === 'apple' && styles.providerApple, pressed && { opacity: 0.75 }]}
            >
              <ProviderMark provider={p.id} />
              <Text style={[styles.providerText, p.id === 'apple' && { color: color.white }]}>Continue with {p.name}</Text>
            </Pressable>
          ))}

          <View style={styles.rosterNote}>
            <ShieldCheck color={color.green} size={22} />
            <Txt v="small" c={color.inkSoft} style={{ flex: 1 }}>
              Only people on the US Mine roster can create an account. Use your name the way payroll has it.
            </Txt>
          </View>
        </View>

        {DEMO_MODE ? (
          <View style={styles.demo}>
            <Txt v="h3">Look around first</Txt>
            <Txt v="small" c={color.silica}>
              This preview runs on sample data that stays on this device. Nothing here is a real US Mine record.
            </Txt>
            <View style={styles.demoRows}>
              <Row
                testID="demo-employee"
                left={<HardHat color={color.ink} size={26} />}
                title="Open as an employee"
                sub="Jordan Rivera, loader operator"
                chevron
                onPress={() => demo('employee')}
              />
              <Divider inset={space.lg} />
              <Row
                testID="demo-supervisor"
                left={<ShieldCheck color={color.ink} size={26} />}
                title="Open as a supervisor"
                sub="Casey Morgan, safety and operations"
                chevron
                onPress={() => demo('supervisor')}
              />
            </View>
          </View>
        ) : null}
      </ScrollView>

      <Sheet
        testID="provider-sheet"
        visible={provider != null}
        onClose={() => setProvider(null)}
        title={`Continue with ${PROVIDERS.find((p) => p.id === provider)?.name ?? ''}`}
      >
        <Txt v="body" c={color.inkSoft}>
          {DEMO_MODE
            ? 'This preview is not connected to the sign-in provider yet, so no outside account is opened. Enter your name as it is on the roster to carry on.'
            : 'Enter your name as it is on the roster so we can match your account.'}
        </Txt>
        <Field testID="provider-first" label="First name" value={providerFirst} onChangeText={setProviderFirst} autoCapitalize="words" />
        <Field testID="provider-last" label="Last name" value={providerLast} onChangeText={setProviderLast} autoCapitalize="words" />
        {providerError ? <Txt v="smallStrong" c={color.red}>{providerError}</Txt> : null}
        <Button testID="provider-continue" label="Continue" kind="ink" onPress={continueWithProvider} />
      </Sheet>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.kaolin },
  field: { backgroundColor: color.ink, paddingHorizontal: space.xl, paddingBottom: 64 },
  form: {
    marginTop: -40,
    marginHorizontal: space.lg,
    padding: space.xl,
    gap: space.lg,
    backgroundColor: color.paper,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.rule,
  },
  nameRow: { flexDirection: 'row', gap: space.md },
  error: { backgroundColor: color.redTint, borderRadius: radius.md, padding: space.md, borderLeftWidth: 6, borderLeftColor: color.red },
  or: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  orLine: { flex: 1, height: 1, backgroundColor: color.rule },
  provider: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: color.silicaLight,
    backgroundColor: color.paper,
  },
  providerApple: { backgroundColor: '#000000', borderColor: '#000000' },
  providerText: { fontFamily: font.bodySemi, fontSize: 18, color: color.ink },
  rosterNote: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  demo: { marginTop: space.xxl, marginHorizontal: space.lg, gap: space.sm },
  demoRows: {
    marginTop: space.sm,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
    overflow: 'hidden',
  },
});
