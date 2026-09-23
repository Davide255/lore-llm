import { useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';

import { fonts, useTheme, type Theme } from '@/theme';

export interface SourceEditorHandle {
  wrap(prefix: string, suffix: string, placeholder?: string): void;
  /** Toggle a line prefix ("# ", "- ", "- [ ] ") on the caret's line. */
  toggleLinePrefix(prefix: string): void;
  focus(offset?: number): void;
  caret(): number;
}

/** Colours markdown markers, like the wireframe's source view (B2). */
function highlight(src: string, t: Theme) {
  return src.split('\n').map((line, i, all) => {
    const nl = i < all.length - 1 ? '\n' : '';
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,6}\s)(.*)$/))) {
      return (
        <Text key={i}>
          <Text style={{ color: t.accentText, fontWeight: '700' }}>{m[1]}</Text>
          <Text style={{ color: t.text, fontWeight: m[1].length === 2 ? '700' : '600' }}>{m[2]}</Text>
          {nl}
        </Text>
      );
    }
    if ((m = line.match(/^(\s*[-*+]\s(?:\[[ xX]\]\s)?|\s*\d+[.)]\s)(.*)$/))) {
      return (
        <Text key={i}>
          <Text style={{ color: t.folder }}>{m[1]}</Text>
          {m[2]}
          {nl}
        </Text>
      );
    }
    if ((m = line.match(/^(\s*>\s?)(.*)$/))) {
      return (
        <Text key={i}>
          <Text style={{ color: t.textMuted }}>{m[1]}</Text>
          {m[2]}
          {nl}
        </Text>
      );
    }
    return (
      <Text key={i}>
        {line}
        {nl}
      </Text>
    );
  });
}

/**
 * Raw markdown editor (B2). The TextInput is uncontrolled-by-value: its
 * content is given as highlighted children so markers are coloured while
 * typing.
 */
export function SourceEditor({
  value,
  onChange,
  ref,
}: {
  value: string;
  onChange: (value: string) => void;
  ref?: Ref<SourceEditorHandle>;
}) {
  const t = useTheme();
  const input = useRef<TextInput>(null);
  const sel = useRef({ start: 0, end: 0 });

  const setCaret = (start: number, end = start) => {
    sel.current = { start, end };
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelection(start, end);
    });
  };

  useImperativeHandle(ref, () => ({
    wrap(prefix, suffix, placeholder = '') {
      const { start, end } = sel.current;
      const inner = value.slice(start, end) || placeholder;
      onChange(value.slice(0, start) + prefix + inner + suffix + value.slice(end));
      setCaret(start + prefix.length + inner.length + (start === end && !placeholder ? 0 : suffix.length));
    },
    toggleLinePrefix(prefix) {
      const { start } = sel.current;
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const rest = value.slice(lineStart);
      const existing = rest.match(/^(#{1,6}\s|\s*[-*+]\s\[[ xX]\]\s|\s*[-*+]\s|\s*\d+[.)]\s|>\s?)/)?.[0] ?? '';
      const replacement = existing === prefix ? '' : prefix;
      onChange(value.slice(0, lineStart) + replacement + rest.slice(existing.length));
      setCaret(Math.max(lineStart, start - existing.length + replacement.length));
    },
    focus(offset) {
      setCaret(offset ?? sel.current.start);
    },
    caret: () => sel.current.start,
  }));

  const children = useMemo(() => highlight(value, t), [value, t]);

  return (
    <TextInput
      ref={input}
      multiline
      scrollEnabled={false}
      onChangeText={onChange}
      onSelectionChange={(e) => (sel.current = e.nativeEvent.selection)}
      autoCorrect={false}
      autoCapitalize="none"
      spellCheck={false}
      selectionColor={t.accentText}
      cursorColor={t.accentText}
      placeholder="# Titolo"
      placeholderTextColor={t.textMuted}
      style={[styles.input, { color: t.textSecondary }]}>
      {children}
    </TextInput>
  );
}

const styles = StyleSheet.create({
  input: {
    fontFamily: fonts.mono,
    fontSize: 12.5,
    lineHeight: 23.75,
    padding: 0,
    minHeight: 300,
    textAlignVertical: 'top',
  },
});
