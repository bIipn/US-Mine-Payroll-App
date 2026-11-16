import { ArrowLeft, Check, ChevronRight, Minus, X, type LucideIcon } from './icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Answer } from '../domain/types';
import { haptic } from '../services/haptics';
import { useStore } from '../store/useStore';
import { color, font, radius, space, TAP, toneColor, type Tone } from '../theme/theme';

// ---------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------

const tabular: TextStyle = { fontVariant: ['tabular-nums'] };

const VARIANT = {
  micro: { fontFamily: font.bodySemi, fontSize: 13, lineHeight: 17 },
  small: { fontFamily: font.body, fontSize: 15, lineHeight: 20 },
  smallStrong: { fontFamily: font.bodySemi, fontSize: 15, lineHeight: 20 },
  body: { fontFamily: font.body, fontSize: 17, lineHeight: 24 },
  strong: { fontFamily: font.bodySemi, fontSize: 17, lineHeight: 24 },
  lead: { fontFamily: font.bodySemi, fontSize: 20, lineHeight: 26 },
  h3: { fontFamily: font.cond, fontSize: 24, lineHeight: 28 },
  h2: { fontFamily: font.condBold, fontSize: 30, lineHeight: 34 },
  h1: { fontFamily: font.condBold, fontSize: 40, lineHeight: 42 },
  num: { fontFamily: font.condBold, fontSize: 34, lineHeight: 36, ...tabular },
  numSm: { fontFamily: font.condBold, fontSize: 24, lineHeight: 26, ...tabular },
  /** Printed-form capitals: time-card column heads and tags only. */
  cap: { fontFamily: font.cond, fontSize: 14, lineHeight: 16, letterSpacing: 1, textTransform: 'uppercase' },
} satisfies Record<string, TextStyle>;

export type TxtVariant = keyof typeof VARIANT;

export function Txt({
  v = 'body',
  c = color.ink,
  center,
  style,
  ...rest
}: TextProps & { v?: TxtVariant; c?: string; center?: boolean }) {
  return <Text {...rest} style={[VARIANT[v], { color: c }, center && styles.center, style]} />;
}

// ---------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------

export type ButtonKind = 'yellow' | 'ink' | 'outline' | 'red' | 'green' | 'blue' | 'quiet' | 'onDark';

const BUTTON: Record<ButtonKind, { bg: string; fg: string; border?: string }> = {
  yellow: { bg: color.yellow, fg: color.ink },
  ink: { bg: color.ink, fg: color.white },
  outline: { bg: color.paper, fg: color.ink, border: color.ink },
  red: { bg: color.red, fg: color.white },
  green: { bg: color.green, fg: color.white },
  blue: { bg: color.blue, fg: color.white },
  quiet: { bg: color.grayTint, fg: color.ink },
  onDark: { bg: 'transparent', fg: color.white, border: color.white },
};

const BUTTON_SIZE = {
  xl: { height: 76, text: { fontFamily: font.condBold, fontSize: 32, lineHeight: 36 } as TextStyle, icon: 30 },
  lg: { height: 60, text: { fontFamily: font.cond, fontSize: 24, lineHeight: 28 } as TextStyle, icon: 24 },
  md: { height: 48, text: { fontFamily: font.bodySemi, fontSize: 17, lineHeight: 22 } as TextStyle, icon: 20 },
};

export interface ButtonProps {
  label: string;
  /** A second, smaller line under the label. */
  sub?: string;
  onPress?: () => void;
  kind?: ButtonKind;
  size?: keyof typeof BUTTON_SIZE;
  icon?: LucideIcon;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Button({ label, sub, onPress, kind = 'yellow', size = 'lg', icon: Icon, disabled, loading, style, testID }: ButtonProps) {
  const look = BUTTON[kind];
  const dims = BUTTON_SIZE[size];
  const blocked = disabled || loading;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={sub ? `${label}. ${sub}` : label}
      accessibilityState={{ disabled: !!blocked, busy: !!loading }}
      disabled={blocked}
      onPress={() => {
        haptic.tap();
        onPress?.();
      }}
      style={({ pressed }) => [
        styles.button,
        { minHeight: dims.height, backgroundColor: look.bg },
        look.border ? { borderWidth: 2, borderColor: look.border } : null,
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={look.fg} /> : Icon ? <Icon color={look.fg} size={dims.icon} strokeWidth={2.5} /> : null}
      <View style={styles.buttonText}>
        <Text style={[dims.text, { color: look.fg }]} numberOfLines={1}>
          {label}
        </Text>
        {sub ? (
          <Text style={[VARIANT.micro, { color: look.fg, opacity: 0.8 }]} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** A square icon-only button with a full-size tap target. */
export function IconButton({ icon: Icon, label, onPress, tint = color.ink, bg, testID }: {
  icon: LucideIcon; label: string; onPress?: () => void; tint?: string; bg?: string; testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={() => {
        haptic.tap();
        onPress?.();
      }}
      style={({ pressed }) => [styles.iconButton, bg ? { backgroundColor: bg } : null, pressed && styles.pressed]}
    >
      <Icon color={tint} size={26} strokeWidth={2.25} />
    </Pressable>
  );
}

// ---------------------------------------------------------------------------------------
// Tags, plates, small pieces
// ---------------------------------------------------------------------------------------

export function Tag({ label, tone = 'neutral', solid, icon: Icon, style }: {
  label: string; tone?: Tone; solid?: boolean; icon?: LucideIcon; style?: StyleProp<ViewStyle>;
}) {
  const t = toneColor[tone];
  const fg = solid ? t.onSolid : t.fg;
  return (
    <View style={[styles.tag, { backgroundColor: solid ? t.solid : t.bg }, style]}>
      {Icon ? <Icon color={fg} size={14} strokeWidth={2.75} /> : null}
      <Text style={[VARIANT.micro, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** A unit number the way it is painted on the machine: black on a yellow plate. */
export function UnitPlate({ unit, size = 'md' }: { unit: string; size?: 'sm' | 'md' | 'lg' }) {
  const dims = { sm: { h: 30, w: 58, f: 18 }, md: { h: 44, w: 80, f: 26 }, lg: { h: 60, w: 112, f: 38 } }[size];
  return (
    <View style={[styles.plate, { height: dims.h, minWidth: dims.w }]}>
      <Text style={{ fontFamily: font.condBold, fontSize: dims.f, lineHeight: dims.f + 2, color: color.ink }}>{unit}</Text>
    </View>
  );
}

export function Avatar({ initials, tone = 'ink', size = 44 }: { initials: string; tone?: Tone; size?: number }) {
  const t = toneColor[tone];
  return (
    <View style={[styles.avatar, { width: size, height: size, backgroundColor: t.solid }]}>
      <Text style={{ fontFamily: font.condBold, fontSize: size * 0.45, color: t.onSolid }}>{initials}</Text>
    </View>
  );
}

export function ProgressBar({ value, tone = 'ok', track = color.grayTint, height = 10 }: {
  value: number; tone?: Tone; track?: string; height?: number;
}) {
  const pct = Math.min(1, Math.max(0, value));
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: track, overflow: 'hidden' }}>
      <View style={{ width: `${pct * 100}%`, height, backgroundColor: toneColor[tone].solid }} />
    </View>
  );
}

export function Divider({ inset = 0 }: { inset?: number }) {
  return <View style={{ height: 1, backgroundColor: color.rule, marginLeft: inset }} />;
}

/** A big figure with a plain label under it. */
export function Stat({ value, label, tone, align = 'left', compact }: {
  value: string; label: string; tone?: Tone; align?: 'left' | 'center';
  /** Smaller figures, for totals that can run to four or five digits. */
  compact?: boolean;
}) {
  return (
    <View style={{ flex: 1, alignItems: align === 'center' ? 'center' : 'flex-start' }}>
      <Txt v={compact ? 'numSm' : 'num'} c={tone ? toneColor[tone].fg : color.ink} numberOfLines={1}>{value}</Txt>
      <Txt v="small" c={color.silica}>{label}</Txt>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Surfaces and rows
// ---------------------------------------------------------------------------------------

export function Panel({ title, action, children, style, flush }: {
  title?: string; action?: React.ReactNode; children: React.ReactNode; style?: StyleProp<ViewStyle>; flush?: boolean;
}) {
  return (
    <View style={style}>
      {title ? (
        <View style={styles.panelHead}>
          <Txt v="h3">{title}</Txt>
          {action}
        </View>
      ) : null}
      <View style={[styles.panel, !flush && { padding: space.lg }]}>{children}</View>
    </View>
  );
}

export function Row({ left, title, sub, below, right, onPress, chevron, testID, titleColor }: {
  left?: React.ReactNode; title: string; sub?: string | null;
  /** Shown under the text, for a status tag too long to sit beside it. */
  below?: React.ReactNode;
  right?: React.ReactNode;
  onPress?: () => void; chevron?: boolean; testID?: string; titleColor?: string;
}) {
  const body = (
    <>
      {left}
      <View style={styles.rowText}>
        <Txt v="strong" c={titleColor} numberOfLines={2}>{title}</Txt>
        {sub ? <Txt v="small" c={color.silica} numberOfLines={2}>{sub}</Txt> : null}
        {below ? <View style={styles.rowBelow}>{below}</View> : null}
      </View>
      {right}
      {chevron ? <ChevronRight color={color.silicaLight} size={22} /> : null}
    </>
  );
  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: color.kaolin }]}
    >
      {body}
    </Pressable>
  );
}

export function EmptyState({ icon: Icon, title, body, action }: {
  icon: LucideIcon; title: string; body: string; action?: React.ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <Icon color={color.silicaLight} size={40} strokeWidth={1.75} />
      <Txt v="h3" center>{title}</Txt>
      <Txt v="small" c={color.silica} center>{body}</Txt>
      {action}
    </View>
  );
}

/** A coloured notice with an icon. Used for warnings a person has to act on. */
export function Notice({ tone, icon: Icon, title, body, children }: {
  tone: Tone; icon?: LucideIcon; title: string; body?: string; children?: React.ReactNode;
}) {
  const t = toneColor[tone];
  return (
    <View style={[styles.notice, { backgroundColor: t.bg, borderLeftColor: t.solid }]}>
      {Icon ? <Icon color={t.fg} size={24} strokeWidth={2.25} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="strong" c={t.fg}>{title}</Txt>
        {body ? <Txt v="small" c={color.inkSoft}>{body}</Txt> : null}
        {children}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------

export function Field({ label, error, hint, right, style, ...input }: TextInputProps & {
  label: string; error?: string | null; hint?: string; right?: React.ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Txt v="smallStrong">{label}</Txt>
      <View style={[styles.field, input.multiline && styles.fieldMulti, focused && styles.fieldFocus, error ? styles.fieldError : null]}>
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={color.silicaLight}
          {...input}
          onFocus={(e) => {
            setFocused(true);
            input.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            input.onBlur?.(e);
          }}
          style={[styles.input, input.multiline && styles.inputMulti, style]}
        />
        {right}
      </View>
      {error ? <Txt v="small" c={color.red}>{error}</Txt> : hint ? <Txt v="small" c={color.silica}>{hint}</Txt> : null}
    </View>
  );
}

export function Segmented<T extends string>({ options, value, onChange, testID }: {
  options: { value: T; label: string }[]; value: T; onChange: (value: T) => void; testID?: string;
}) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((option, i) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={testID ? `${testID}-${option.value}` : undefined}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              haptic.tap();
              onChange(option.value);
            }}
            // A line between choices, so two that are both off still read as two.
            style={[styles.segment, i > 0 && styles.segmentNext, on && styles.segmentOn]}
          >
            <Text style={[VARIANT.smallStrong, { color: on ? color.white : color.ink }]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A side-scrolling strip of filters. `wrap` lays every choice out on lines instead, so none is out of sight. */
export function Chips<T extends string>({ options, value, onChange, testID, wrap }: {
  options: { value: T; label: string }[]; value: T; onChange: (value: T) => void; testID?: string; wrap?: boolean;
}) {
  const chips = options.map((option) => {
    const on = option.value === value;
    return (
      <Pressable
        key={option.value}
        testID={testID ? `${testID}-${option.value}` : undefined}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        onPress={() => {
          haptic.tap();
          onChange(option.value);
        }}
        style={[styles.chip, on && styles.chipOn]}
      >
        <Text style={[VARIANT.smallStrong, { color: on ? color.white : color.ink }]}>{option.label}</Text>
      </Pressable>
    );
  });
  if (wrap) return <View style={styles.chipsWrap}>{chips}</View>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
      {chips}
    </ScrollView>
  );
}

/** A row with a label and an on/off switch drawn large enough for a thumb. */
export function Toggle({ label, sub, value, onChange, testID }: {
  label: string; sub?: string; value: boolean; onChange: (value: boolean) => void; testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      onPress={() => {
        haptic.tap();
        onChange(!value);
      }}
      style={styles.row}
    >
      <View style={styles.rowText}>
        <Txt v="strong">{label}</Txt>
        {sub ? <Txt v="small" c={color.silica}>{sub}</Txt> : null}
      </View>
      <View style={[styles.switch, value && styles.switchOn]}>
        <View style={[styles.knob, value && styles.knobOn]} />
      </View>
    </Pressable>
  );
}

/** A check row for a statement the person confirms. */
export function CheckRow({ label, sub, value, onChange, testID }: {
  label: string; sub?: string; value: boolean; onChange: (value: boolean) => void; testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      onPress={() => {
        haptic.tap();
        onChange(!value);
      }}
      style={styles.checkRow}
    >
      <View style={[styles.checkBox, value && styles.checkBoxOn]}>
        {value ? <Check color={color.white} size={24} strokeWidth={3} /> : null}
      </View>
      <View style={styles.rowText}>
        <Txt v="strong">{label}</Txt>
        {sub ? <Txt v="small" c={color.silica}>{sub}</Txt> : null}
      </View>
    </Pressable>
  );
}

const TRI: { value: Answer; label: string; icon: LucideIcon; tone: Tone; say: string }[] = [
  { value: 'ok', label: 'OK', icon: Check, tone: 'ok', say: 'OK' },
  { value: 'bo', label: 'BO', icon: X, tone: 'bo', say: 'Bad order' },
  { value: 'na', label: 'N/A', icon: Minus, tone: 'neutral', say: 'Not applicable' },
];

/** The three answers on a line of a checklist or an exam: OK, Bad Order, Not applicable. */
export function TriChoice({ value, onChange, testID }: {
  value?: Answer; onChange: (value: Answer) => void; testID?: string;
}) {
  return (
    <View style={styles.tri}>
      {TRI.map((option) => {
        const on = value === option.value;
        const t = toneColor[option.tone];
        const Icon = option.icon;
        return (
          <Pressable
            key={option.value}
            testID={testID ? `${testID}-${option.value}` : undefined}
            accessibilityRole="radio"
            accessibilityLabel={option.say}
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (option.value === 'bo') haptic.warning();
              else haptic.tap();
              onChange(option.value);
            }}
            style={({ pressed }) => [
              styles.triButton,
              on ? { backgroundColor: t.solid, borderColor: t.solid } : null,
              pressed && styles.pressed,
            ]}
          >
            <Icon color={on ? t.onSolid : t.solid} size={22} strokeWidth={3} />
            <Text style={{ fontFamily: font.condBold, fontSize: 24, lineHeight: 28, color: on ? t.onSolid : color.ink }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A row of choices where more than one can be on at once. */
export function MultiChoice<T extends string>({ options, value, onChange, tone = 'bo', testID }: {
  options: { value: T; label: string }[]; value: T[]; onChange: (value: T[]) => void; tone?: Tone; testID?: string;
}) {
  const t = toneColor[tone];
  return (
    <View style={styles.tri}>
      {options.map((option) => {
        const on = value.includes(option.value);
        return (
          <Pressable
            key={option.value}
            testID={testID ? `${testID}-${option.value}` : undefined}
            accessibilityRole="checkbox"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: on }}
            onPress={() => {
              haptic.tap();
              onChange(on ? value.filter((v) => v !== option.value) : [...value, option.value]);
            }}
            style={({ pressed }) => [
              styles.triButton,
              styles.multiButton,
              on ? { backgroundColor: t.solid, borderColor: t.solid } : null,
              pressed && styles.pressed,
            ]}
          >
            {on ? <Check color={t.onSolid} size={18} strokeWidth={3} /> : null}
            <Text style={[VARIANT.smallStrong, { color: on ? t.onSolid : color.ink, textAlign: 'center' }]} numberOfLines={2}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------------------

export function TopBar({ title, sub, onBack, right, dark }: {
  title: string; sub?: string; onBack?: () => void; right?: React.ReactNode; dark?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const fg = dark ? color.white : color.ink;
  return (
    <View style={[styles.topBar, { paddingTop: insets.top + 6, backgroundColor: dark ? color.ink : color.kaolin }]}>
      {onBack ? <IconButton icon={ArrowLeft} label="Back" onPress={onBack} tint={fg} testID="back" /> : null}
      <View style={{ flex: 1, paddingLeft: onBack ? 4 : space.xl - 8 }}>
        <Txt v={onBack ? 'h3' : 'h2'} c={fg} numberOfLines={1} accessibilityRole="header">{title}</Txt>
        {sub ? <Txt v="small" c={dark ? color.onDarkMuted : color.silica} numberOfLines={1}>{sub}</Txt> : null}
      </View>
      {right}
    </View>
  );
}

/** Standard screen: title bar, scrolling body, optional pinned footer. */
export function Page({ title, sub, onBack, right, children, footer, scroll = true, pad = true, testID }: {
  title: string; sub?: string; onBack?: () => void; right?: React.ReactNode; children: React.ReactNode;
  footer?: React.ReactNode; scroll?: boolean; pad?: boolean; testID?: string;
}) {
  const insets = useSafeAreaInsets();
  const body = scroll ? (
    <ScrollView
      testID={testID}
      style={styles.flex}
      contentContainerStyle={[pad && styles.pagePad, { paddingBottom: space.xxl + (footer ? 0 : insets.bottom) }]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View testID={testID} style={[styles.flex, pad && styles.pagePad]}>{children}</View>
  );
  return (
    <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <TopBar title={title} sub={sub} onBack={onBack} right={right} />
      {body}
      {footer ? <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space.md) }]}>{footer}</View> : null}
    </KeyboardAvoidingView>
  );
}

/** A sheet that slides up from the bottom for a decision or a short form. */
export function Sheet({ visible, onClose, title, children, testID }: {
  visible: boolean; onClose: () => void; title?: string; children: React.ReactNode; testID?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={styles.sheetWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
        <View testID={testID} style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.lg) }]}>
          <View style={styles.sheetHead}>
            <View style={{ flex: 1 }}>{title ? <Txt v="h2" accessibilityRole="header">{title}</Txt> : null}</View>
            <IconButton icon={X} label="Close" onPress={onClose} bg={color.grayTint} testID="sheet-close" />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space.lg, paddingBottom: space.sm }}>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** One short confirmation at a time, shown at the top of the screen. */
export function ToastHost() {
  const toast = useStore((s) => s.toast);
  const clear = useStore((s) => s.clearToast);
  const insets = useSafeAreaInsets();
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!toast) return;
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: Platform.OS !== 'web' }).start();
    const shown = toast;
    const timer = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: Platform.OS !== 'web' }).start(({ finished }) => {
        // A newer message can arrive while this one is fading out. That one is not this one's to clear.
        if (finished && useStore.getState().toast === shown) clear();
      });
    }, 3200);
    return () => clearTimeout(timer);
  }, [toast, opacity, clear]);

  if (!toast) return null;
  const t = toneColor[toast.tone];
  return (
    <Animated.View pointerEvents="none" style={[styles.toastWrap, { top: insets.top + 8, opacity }]}>
      <View testID="toast" accessibilityLiveRegion="polite" style={[styles.toast, { backgroundColor: toast.tone === 'ok' ? color.ink : t.solid }]}>
        <Txt v="strong" c={color.white} center>{toast.message}</Txt>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.38 },

  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    borderRadius: radius.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
  },
  buttonText: { alignItems: 'center', flexShrink: 1 },
  iconButton: { width: 48, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },

  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    minHeight: 26,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: radius.sm,
  },
  plate: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: radius.sm,
    backgroundColor: color.yellow,
    borderWidth: 2,
    borderColor: color.ink,
  },
  avatar: { borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },

  panelHead: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginBottom: space.sm,
    minHeight: 32,
  },
  panel: {
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.rule,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 68,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  rowText: { flex: 1, gap: 1 },
  rowBelow: { marginTop: 5, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  empty: { alignItems: 'center', gap: space.sm, paddingVertical: space.xxxl, paddingHorizontal: space.xl },
  notice: {
    flexDirection: 'row',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    borderLeftWidth: 6,
  },

  field: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: TAP,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: color.silicaLight,
    backgroundColor: color.paper,
    paddingHorizontal: space.lg,
  },
  fieldMulti: { alignItems: 'flex-start', paddingVertical: space.md },
  fieldFocus: { borderColor: color.ink, borderWidth: 2.5, paddingHorizontal: space.lg - 1 },
  fieldError: { borderColor: color.red },
  input: {
    flex: 1,
    minHeight: TAP - 4,
    fontFamily: font.body,
    fontSize: 18,
    color: color.ink,
    paddingVertical: 0,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
  },
  inputMulti: { minHeight: 96, textAlignVertical: 'top', lineHeight: 24 },

  segmented: {
    flexDirection: 'row',
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: color.ink,
    backgroundColor: color.paper,
    overflow: 'hidden',
  },
  segment: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  segmentNext: { borderLeftWidth: 2, borderLeftColor: color.ink },
  segmentOn: { backgroundColor: color.ink },
  chips: { gap: space.sm, paddingRight: space.xl },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 44,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: color.silicaLight,
    backgroundColor: color.paper,
  },
  chipOn: { backgroundColor: color.ink, borderColor: color.ink },

  switch: { width: 60, height: 36, borderRadius: 18, backgroundColor: color.silicaLight, padding: 3 },
  switchOn: { backgroundColor: color.green },
  knob: { width: 30, height: 30, borderRadius: 15, backgroundColor: color.white },
  knobOn: { marginLeft: 24 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: TAP, paddingVertical: space.sm },
  checkBox: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: color.ink,
    backgroundColor: color.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxOn: { backgroundColor: color.green, borderColor: color.green },

  tri: { flexDirection: 'row', gap: space.sm },
  triButton: {
    flex: 1,
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: color.silicaLight,
    backgroundColor: color.paper,
  },
  multiButton: { minHeight: TAP, gap: 4, paddingHorizontal: 4 },

  page: { flex: 1, backgroundColor: color.kaolin },
  pagePad: { paddingHorizontal: space.xl, paddingTop: space.sm, gap: space.xl },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingBottom: 8,
    minHeight: 60,
  },
  footer: {
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    gap: space.sm,
    backgroundColor: color.paper,
    borderTopWidth: 1,
    borderTopColor: color.rule,
  },

  sheetWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(28,27,25,0.6)' },
  sheet: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    maxHeight: '92%',
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md },

  toastWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 50 },
  toast: { maxWidth: 480, marginHorizontal: space.xl, paddingHorizontal: space.xl, paddingVertical: space.md, borderRadius: radius.md },
});
