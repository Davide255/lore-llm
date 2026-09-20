import React from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { Colors, Fonts } from '@/constants/theme';

interface MarkdownViewerProps {
  content: string;
}

export function MarkdownViewer({ content }: MarkdownViewerProps) {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];

  const markdownStyles = StyleSheet.create({
    body: {
      color: colors.text,
      fontSize: 16,
      lineHeight: 24,
      fontFamily: Fonts?.sans ?? 'normal',
    },
    heading1: {
      color: colors.text,
      fontSize: 26,
      fontWeight: '700',
      marginTop: 18,
      marginBottom: 10,
      fontFamily: Fonts?.sans ?? 'normal',
    },
    heading2: {
      color: colors.text,
      fontSize: 21,
      fontWeight: '600',
      marginTop: 16,
      marginBottom: 8,
      fontFamily: Fonts?.sans ?? 'normal',
    },
    heading3: {
      color: colors.text,
      fontSize: 18,
      fontWeight: '600',
      marginTop: 12,
      marginBottom: 6,
      fontFamily: Fonts?.sans ?? 'normal',
    },
    heading4: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '600',
      marginTop: 10,
      marginBottom: 4,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 12,
    },
    code_inline: {
      backgroundColor: colors.codeBg,
      color: colors.primary,
      fontFamily: Fonts?.mono ?? 'monospace',
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      fontSize: 14,
    },
    code_block: {
      backgroundColor: colors.codeBg,
      color: colors.text,
      fontFamily: Fonts?.mono ?? 'monospace',
      padding: 12,
      borderRadius: 8,
      fontSize: 13,
      marginVertical: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    fence: {
      backgroundColor: colors.codeBg,
      color: colors.text,
      fontFamily: Fonts?.mono ?? 'monospace',
      padding: 12,
      borderRadius: 8,
      fontSize: 13,
      marginVertical: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    blockquote: {
      backgroundColor: colors.backgroundElement,
      borderLeftColor: colors.primary,
      borderLeftWidth: 4,
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginVertical: 10,
      borderRadius: 4,
    },
    hr: {
      backgroundColor: colors.border,
      height: 1,
      marginVertical: 16,
    },
    bullet_list: {
      marginVertical: 8,
    },
    ordered_list: {
      marginVertical: 8,
    },
    list_item: {
      marginVertical: 3,
    },
    table: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      marginVertical: 12,
    },
    th: {
      backgroundColor: colors.backgroundElement,
      padding: 8,
      fontWeight: '600',
      color: colors.text,
    },
    td: {
      padding: 8,
      borderTopWidth: 1,
      borderColor: colors.border,
      color: colors.text,
    },
    link: {
      color: colors.primary,
      textDecorationLine: 'underline',
    },
    strong: {
      fontWeight: '700',
      color: colors.text,
    },
    em: {
      fontStyle: 'italic',
    },
  });

  return <Markdown style={markdownStyles}>{content}</Markdown>;
}
