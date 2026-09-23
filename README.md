# lore-llm

A mobile app for editing a **knowledge base shared between you and your AI agents** (Claude, Codex, …). You browse, write and organise markdown; the agents read and write the same files through an MCP server, and the app shows you what they changed.

Built with Expo (SDK 57) and Expo Router, using native system components wherever possible — on iOS 26 the tab bar, header buttons, bottom toolbar and menus render with Liquid Glass.

> **Status:** the UI is complete; the backend does not exist yet. The app runs against an on-device mock that behaves like the planned service (see [Backend](#backend)).

## The knowledge base

```
<root>/
  <project>/          top-level folders are "projects"
    index.md          compiled automatically by the backend — read-only in the app
    checklist.md      nested task list, ticked directly from the viewer
    *.md, <folders>/  free-form markdown files and subfolders
```

- **index.md** is regenerated after every change to its project. It can't be edited, renamed, moved or deleted.
- **checklist.md** is regular markdown (`- [ ]` / `- [x]`, indented for sub-items). Tapping a box rewrites only that line of the source.
- Everything else is plain markdown the user (and agents) can create, edit, rename, move, duplicate, share and delete.

## Features

The UI follows the *KB Wireframes* design (Athly design system), organised in six flows. UI copy is in Italian, as in the design.

| Flow | Screens |
| --- | --- |
| **A · Browse & read** | Projects list with checklist progress · project/folder contents · `index.md` (read-only) · `checklist.md` · rendered documents with in-app links between files |
| **B · Edit** | Live-preview block editor and raw source editor (segmented control), a floating glass formatting toolbar that follows the keyboard, undo, and an unsaved-changes sheet on exit |
| **C · Create** | One "+" entry point → new `.md` file (with templates), new folder, or "paste markdown" (name taken from the H1) · new project with optional `checklist.md` |
| **D · Search** | Full-text search across the base, recent searches, project filter pills, highlighted snippets |
| **E · Manage** | Swipe actions (rename / delete), long-press context menu with preview, delete confirmation, 10-second undo toast |
| **F · Agents** | Activity feed of agent reads/writes · unified diff of a change with restore · per-agent permissions (read / read-write) · connect an agent via MCP |

Plus: light/dark themes from the design system, with an in-app **Aspetto** setting (System / Light / Dark) in Settings.

## Tech stack

- **Expo SDK 57**, React Native 0.86, React 19 with the React Compiler enabled
- **Expo Router** — file-based routes, `NativeTabs`, `Stack.Toolbar`, `Stack.SearchBar`, `Link.Menu` / `Link.Preview`
- **Native UI** — `expo-symbols` (SF Symbols on iOS, Material Symbols on Android/web), `expo-glass-effect`, `@expo/ui` segmented control, system `Switch`, `Alert` and `ActionSheetIOS`
- `react-native-gesture-handler` (swipe rows), `react-native-reanimated` (keyboard-tracking toolbar, toasts)
- `@react-native-async-storage/async-storage` (mock persistence, appearance preference), `expo-clipboard`
- TypeScript (strict), ESLint (`eslint-config-expo`)

Android and web get functional fallbacks where iOS-only native pieces don't exist (header icon buttons instead of `Stack.Toolbar` items, a floating action button, a bottom sheet instead of `ActionSheetIOS`).

## Project structure

```
src/
  app/                    Expo Router routes
    _layout.tsx           root stack, providers, toast/sheet hosts
    (tabs)/               native tab bar: (projects), search, activity, settings
    folder/[...path].tsx  project or folder contents
    file/[...path].tsx    viewer for index.md, checklist.md and documents
    edit/[...path].tsx    editor (modal)
    change/[id].tsx       diff of an agent change
    agent/[id].tsx        agent permissions
    new-file, new-project, rename, move, connect-agent   modal forms
  api/
    types.ts              domain types (Project, FileDocument, Change, Agent…)
    client.ts             KnowledgeBaseClient interface — the backend contract
    http-client.ts        REST implementation (ready, not yet used)
    mock/                 on-device implementation + demo seed data
    index.ts              picks the client the app uses
  data/
    store.ts              small stale-while-revalidate query cache + signals
    hooks.ts              useProjects/useFolder/useFile/… and mutation actions
  components/             UI building blocks (grouped lists, header items,
                          markdown renderer, entry rows, floating toolbar,
                          action sheet, toast, editor/)
  lib/                    markdown parser/serializer, diff, paths, routes, formatting
  theme/                  design tokens (light/dark) and appearance preference
```

Screens only talk to `src/data/hooks.ts`, which only talks to the `KnowledgeBaseClient` interface. Nothing in the UI knows whether it's hitting the mock or a server.

## Getting started

Requirements: a current Node LTS, Xcode 26 (for iOS 26 / Liquid Glass), Android Studio for Android. The app uses native modules, so it runs in a **development build**, not Expo Go.

```bash
npm install
npx expo run:ios        # builds the native app and starts Metro
npx expo run:android
```

After the first native build, `npx expo start` is enough for JS-only changes. Rebuild natively when you add or upgrade a package with native code.

Useful scripts:

```bash
npm run typecheck       # tsc --noEmit
npm run lint            # expo lint
npm run web             # web preview (functional fallbacks, no Liquid Glass)
```

### Standalone build on an iPhone

A Release build embeds the JS bundle, so it runs without Metro. With the phone connected and Developer Mode enabled:

```bash
cd ios
xcodebuild -workspace lorellm.xcworkspace -scheme lorellm -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath build-release \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<YOUR_TEAM_ID> CODE_SIGN_STYLE=Automatic build

xcrun devicectl list devices    # find the device identifier
xcrun devicectl device install app --device <DEVICE_ID> \
  build-release/Build/Products/Release-iphoneos/lorellm.app
```

Development-signed builds expire (about a year on a paid Apple Developer account, 7 days on a free one). For TestFlight or distribution, use EAS Build or an Xcode archive.

## Backend

The planned infrastructure is described in [`Production plan.md`](./Production%20plan.md): Cognito for auth, Cloudflare R2 for storage (`{user_id}/{project}/…`), and a Cloudflare Worker exposing both a REST API for the app and an MCP server (SSE) for agents, which also recompiles `index.md` after each write.

**Today** the app uses `MockKnowledgeBaseClient` (`src/api/mock/`), which:

- keeps the whole base in memory and persists it to AsyncStorage, so edits survive restarts;
- seeds demo content matching the wireframes (5 projects, agents, activity, changes);
- simulates background `index.md` compilation, soft deletes with undo, optimistic-concurrency conflicts, and restoring an agent's change.

While the mock is active, **Settings › Sviluppo › Ripristina dati demo** resets the seed data (the section disappears once a real client is plugged in).

**To connect the real backend:**

1. Implement the Worker endpoints. `src/api/http-client.ts` documents the proposed REST contract (`/v1/projects`, `/v1/files`, `/v1/search`, `/v1/changes/:id/revert`, …) — adjust the routes there if the server differs.
2. Provide the Cognito access token (from the keychain) as `getToken`.
3. Swap the client in `src/api/index.ts`:
   ```ts
   export const kb: KnowledgeBaseClient = new HttpKnowledgeBaseClient(
     process.env.EXPO_PUBLIC_KB_API_URL!,
     getAccessToken,
   );
   ```
4. Wire server-pushed events (index recompiled, agent writes) into `HttpKnowledgeBaseClient.subscribe` — currently a TODO for an SSE stream.

No screen code needs to change.

## Known limitations

- **Inline formatting in preview mode:** block markers (`#`, `-`, `[ ]`, `>`) are hidden, but inline markers such as `**bold**` remain visible while typing. Hiding them needs a rich-text editor.
- **Full swipe to delete** isn't implemented; swiping reveals the Rename/Delete buttons.
- **Toasts** render underneath native modals (screens inside modals use inline feedback instead).
- Android has not been tested on a device yet.
