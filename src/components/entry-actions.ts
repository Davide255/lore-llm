import { router } from 'expo-router';
import { Alert, Share } from 'react-native';

import type { MenuItem } from './header-items';
import { showToast } from './toast';
import { kb, type Entry } from '@/api';
import { actions, attempt } from '@/data/hooks';
import { isProjectRoot } from '@/lib/paths';
import { routes } from '@/lib/routes';

export function confirmDelete(entry: Pick<Entry, 'path' | 'name' | 'kind'> & { fileCount?: number }, onDeleted?: () => void) {
  const isFolder = entry.kind === 'folder';
  const title = isFolder ? (isProjectRoot(entry.path) ? 'Eliminare il progetto?' : 'Eliminare la cartella?') : 'Eliminare il file?';
  const message = isFolder
    ? `${entry.name} e ${entry.fileCount === 1 ? 'il file contenuto' : `i ${entry.fileCount ?? 0} file contenuti`} verranno rimossi dalla base e dal contesto degli agenti.`
    : `${entry.name} verrà rimosso dalla base e dal contesto degli agenti.`;
  Alert.alert(title, message, [
    { text: 'Annulla', style: 'cancel' },
    {
      text: 'Elimina',
      style: 'destructive',
      onPress: async () => {
        const receipt = await attempt(() => actions.remove(entry.path), 'Eliminazione non riuscita');
        if (!receipt) return;
        onDeleted?.();
        showToast({
          icon: 'delete',
          subject: entry.name,
          message: 'eliminato',
          actionLabel: 'Annulla',
          duration: new Date(receipt.undoUntil).getTime() - Date.now(),
          onAction: () => attempt(() => actions.undoRemove(receipt.token), 'Ripristino non riuscito'),
        });
      },
    },
  ]);
}

export async function shareEntry(path: string, name: string) {
  const doc = await attempt(() => kb.getFile(path));
  if (doc) Share.share({ title: name, message: doc.content });
}

export async function duplicateEntry(path: string) {
  const target = await attempt(() => actions.duplicate(path));
  if (target) showToast({ icon: 'duplicate', subject: target.split('/').pop(), message: 'creato' });
}

/** Actions for the long-press menu (E2). `role` gates what special files allow. */
export function entryMenu(entry: Entry): MenuItem[] {
  const isFile = entry.kind === 'file';
  const special = isFile && entry.role !== 'doc';
  const items: MenuItem[] = [{ label: 'Apri', icon: 'open', onPress: () => router.push(routes.entry(entry.path, entry.kind)) }];
  if (isFile && entry.role !== 'index') items.push({ label: 'Modifica', icon: 'edit', onPress: () => router.push(routes.edit(entry.path)) });
  if (!special) {
    items.push({ label: 'Rinomina', icon: 'rename', onPress: () => router.push(routes.rename(entry.path)) });
    if (!isProjectRoot(entry.path)) {
      items.push({ label: 'Sposta in…', icon: 'move', onPress: () => router.push(routes.move(entry.path)) });
    }
  }
  if (isFile && !special) items.push({ label: 'Duplica', icon: 'duplicate', onPress: () => duplicateEntry(entry.path) });
  if (isFile) items.push({ label: 'Condividi', icon: 'share', onPress: () => shareEntry(entry.path, entry.name) });
  if (!(isFile && entry.role === 'index')) {
    items.push({
      label: 'Elimina',
      icon: 'delete',
      destructive: true,
      onPress: () => confirmDelete({ ...entry, fileCount: entry.kind === 'folder' ? entry.fileCount : undefined }),
    });
  }
  return items;
}
