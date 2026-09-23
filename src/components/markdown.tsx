import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Fragment, useMemo, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon } from './icon';
import { parse, parseInline, parseTable, type Block, type Inline } from '@/lib/markdown';
import { resolveLink } from '@/lib/paths';
import { routes } from '@/lib/routes';
import { fonts, useTheme, type Theme } from '@/theme';

function openLink(fromFile: string, href: string) {
  const target = resolveLink(fromFile, href);
  if (target === null) {
    if (/^https?:/i.test(href)) WebBrowser.openBrowserAsync(href);
    return;
  }
  router.push(target.endsWith('.md') ? routes.file(target) : routes.folder(target));
}

export function InlineText({ source, path, t }: { source: string; path: string; t: Theme }) {
  const render = (nodes: Inline[]): ReactNode =>
    nodes.map((n, i) => {
      switch (n.type) {
        case 'text':
          return <Fragment key={i}>{n.text}</Fragment>;
        case 'bold':
          return (
            <Text key={i} style={{ fontWeight: '600', color: t.text }}>
              {render(n.children)}
            </Text>
          );
        case 'italic':
          return (
            <Text key={i} style={{ fontStyle: 'italic' }}>
              {render(n.children)}
            </Text>
          );
        case 'strike':
          return (
            <Text key={i} style={{ textDecorationLine: 'line-through' }}>
              {render(n.children)}
            </Text>
          );
        case 'code':
          return (
            <Text key={i} style={{ fontFamily: fonts.mono, color: t.text, fontSize: 13.5 }}>
              {n.text}
            </Text>
          );
        case 'link':
          return (
            <Text key={i} style={{ color: t.accentText }} onPress={() => openLink(path, n.href)}>
              {render(n.children)}
            </Text>
          );
      }
    });
  return <>{render(parseInline(source))}</>;
}

export function MarkdownView({
  content,
  path,
  onToggleTask,
}: {
  content: string;
  /** File path, for resolving relative links. */
  path: string;
  /** When set, task checkboxes are interactive and report their source line. */
  onToggleTask?: (line: number) => void;
}) {
  const t = useTheme();
  const blocks = useMemo(() => parse(content), [content]);
  return (
    <View>
      {blocks.map((b, i) => (
        <BlockView key={`${b.line}-${i}`} block={b} prev={blocks[i - 1]} path={path} t={t} onToggleTask={onToggleTask} />
      ))}
    </View>
  );
}

function BlockView({
  block: b,
  prev,
  path,
  t,
  onToggleTask,
}: {
  block: Block;
  prev?: Block;
  path: string;
  t: Theme;
  onToggleTask?: (line: number) => void;
}) {
  const inline = (s: string) => <InlineText source={s} path={path} t={t} />;
  switch (b.type) {
    case 'heading':
      return (
        <Text
          style={[
            b.level === 1 ? styles.h1 : b.level === 2 ? styles.h2 : styles.h3,
            { color: t.text },
            !prev && { marginTop: 0 },
          ]}>
          {inline(b.text)}
        </Text>
      );
    case 'paragraph':
      return <Text style={[styles.p, { color: t.textBody }]}>{inline(b.text)}</Text>;
    case 'bullet':
    case 'ordered':
      return (
        <View style={[styles.li, { marginLeft: b.indent * 20 }]}>
          <Text style={[styles.liText, { color: t.accentText, minWidth: b.type === 'ordered' ? 18 : 8 }]}>
            {b.type === 'ordered' ? `${b.n}.` : '•'}
          </Text>
          <Text style={[styles.liText, { flex: 1, color: t.textBody }]}>{inline(b.text)}</Text>
        </View>
      );
    case 'task': {
      const nested = b.indent > 0;
      const size = nested ? 18 : 20;
      const top = prev?.type === 'task' || !prev ? 0 : 10;
      return (
        <Pressable
          disabled={!onToggleTask}
          onPress={() => onToggleTask?.(b.line)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: b.checked }}
          style={[styles.task, { marginLeft: b.indent * 30, marginTop: top }]}>
          <Icon name={b.checked ? 'checkCircle' : 'circle'} size={size} color={b.checked ? t.accentText : t.textMuted} />
          <Text
            style={[
              { flex: 1, fontSize: nested ? 13.5 : 14.5, lineHeight: nested ? 19.5 : 21 },
              b.checked ? { color: t.textMuted, textDecorationLine: 'line-through' } : { color: t.text },
            ]}>
            {inline(b.text)}
          </Text>
        </Pressable>
      );
    }
    case 'quote':
      return (
        <View style={[styles.quote, { backgroundColor: t.cell, borderLeftColor: t.accent }]}>
          <Text style={{ fontSize: 13.5, lineHeight: 21, color: t.textSecondary }}>{inline(b.text)}</Text>
        </View>
      );
    case 'code':
      return (
        <View style={[styles.code, { backgroundColor: t.cell }]}>
          <Text style={{ fontFamily: fonts.mono, fontSize: 11.5, lineHeight: 19.5, color: t.textSecondary }}>{b.text}</Text>
        </View>
      );
    case 'table':
      return <TableView source={b.text} path={path} t={t} />;
    case 'rule':
      return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.hairline, marginVertical: 18 }} />;
  }
}

/**
 * Laid out column by column so each column sizes to its widest cell; cells
 * never wrap (the table scrolls horizontally instead), which keeps rows aligned.
 */
function TableView({ source, path, t }: { source: string; path: string; t: Theme }) {
  const { header, align, rows } = useMemo(() => parseTable(source), [source]);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.table, { borderColor: t.hairline, backgroundColor: t.cell }]}
      contentContainerStyle={{ flexGrow: 1 }}>
      {header.map((h, c) => {
        const textAlign = align[c] ?? 'left';
        const border = c > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: t.hairline };
        return (
          <View key={c} style={[styles.column, border]}>
            <View
              style={[
                styles.th,
                { backgroundColor: t.fillSubtle },
                rows.length > 0 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.hairline },
              ]}>
              <Text style={[styles.cellText, { color: t.text, fontWeight: '600', textAlign }]}>
                <InlineText source={h} path={path} t={t} />
              </Text>
            </View>
            {rows.map((r, i) => (
              <View
                key={i}
                style={[styles.td, i < rows.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.hairline }]}>
                <Text style={[styles.cellText, { color: t.textBody, textAlign }]}>
                  <InlineText source={r[c]} path={path} t={t} />
                </Text>
              </View>
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  h1: { fontSize: 23, lineHeight: 28, fontWeight: '700', letterSpacing: -0.7, marginTop: 8, marginBottom: 10 },
  h2: { fontSize: 16, lineHeight: 21, fontWeight: '600', letterSpacing: -0.3, marginTop: 19, marginBottom: 8 },
  h3: { fontSize: 14.5, lineHeight: 20, fontWeight: '600', marginTop: 14, marginBottom: 6 },
  p: { fontSize: 14.5, lineHeight: 22.5, letterSpacing: -0.15, marginBottom: 12 },
  li: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  liText: { fontSize: 14.5, lineHeight: 21.75, letterSpacing: -0.15 },
  task: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 5 },
  quote: {
    borderLeftWidth: 3,
    borderTopLeftRadius: 4,
    borderBottomLeftRadius: 4,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  code: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 12 },
  table: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, marginBottom: 12, flexGrow: 0 },
  column: { flexGrow: 1, flexShrink: 0 },
  // Cells are one line, so a fixed height keeps rows aligned across columns
  // even when inline spans (e.g. monospace code) have different metrics.
  th: { height: 37, justifyContent: 'center', paddingHorizontal: 12 },
  td: { height: 37, justifyContent: 'center', paddingHorizontal: 12 },
  cellText: { fontSize: 13.5, lineHeight: 20 },
});
