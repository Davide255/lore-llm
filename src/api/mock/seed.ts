import type { ActivityEvent, Agent, Change, ProjectIcon } from '../types';

/** Demo content mirroring the wireframes. Timestamps are offsets from "now". */

const M = 60_000;
const H = 60 * M;
const D = 24 * H;

export interface SeedFile {
  path: string;
  content: string;
  ago: number;
}

export interface SeedProject {
  name: string;
  description: string;
  icon: ProjectIcon;
  folders: string[];
}

export const seedProjects: SeedProject[] = [
  {
    name: 'Athly Dashboard',
    description: 'Pannello web per personal trainer: clienti, programmi e metriche. React + TypeScript su Framework7.',
    icon: 'fitness',
    folders: ['architettura', 'decisioni', 'decisioni/archivio'],
  },
  {
    name: 'Sito Athly',
    description: 'Sito marketing e landing page per trainer e atleti.',
    icon: 'web',
    folders: ['pagine'],
  },
  {
    name: 'Server & API',
    description: 'Backend Node, API REST e job in background.',
    icon: 'server',
    folders: [],
  },
  {
    name: 'Brand & voce',
    description: 'Identità visiva, tono di voce e linee guida editoriali.',
    icon: 'campaign',
    folders: [],
  },
  {
    name: 'Ricerca LLM',
    description: 'Appunti su modelli, prompt e valutazioni.',
    icon: 'science',
    folders: ['esperimenti'],
  },
];

export const seedFiles: SeedFile[] = [
  // ── Athly Dashboard ────────────────────────────────────────────────────────
  {
    path: 'Athly Dashboard/index.md',
    ago: 2 * M,
    content: `# Athly Dashboard

Pannello web per personal trainer: clienti, programmi e metriche. React + TypeScript su Framework7.

## Struttura

\`\`\`
architettura/   4 file
decisioni/      6 file
onboarding.md
tono-di-voce.md
glossario.md
\`\`\`

## Concetti chiave

- \`Cliente\` — atleta seguito dal trainer
- \`Programma\` — ciclo con scadenza
- \`Codice invito\` — aggancia l'app atleta
`,
  },
  {
    path: 'Athly Dashboard/checklist.md',
    ago: 2 * H,
    content: `## Rilascio v2.4

- [x] Migrazione tema scuro
  - [x] Token colore
  - [x] Grafici MUI
- [ ] Sidebar collassabile sotto 1200px
  - [x] Breakpoint
  - [ ] Gesto swipe
- [ ] Export PDF dei programmi

## Debito tecnico

- [ ] Rimuovere Framework7 Icons
- [x] Unificare i file LESS

## Qualità

- [x] Test end-to-end login
- [x] Test end-to-end onboarding
- [x] Test unitari reducer
- [x] Monitoraggio errori
- [x] Budget prestazioni home
- [x] Lighthouse sopra 90
- [x] Audit accessibilità
- [x] Contrasto colori
- [x] Etichette form
- [x] Navigazione da tastiera
- [x] Screen reader sui grafici
- [ ] Focus trap nei dialog
- [ ] Riduzione animazioni
- [ ] Test su Safari iOS 17
- [x] Traduzioni EN
- [ ] Traduzioni ES
`,
  },
  {
    path: 'Athly Dashboard/onboarding.md',
    ago: 2 * M,
    content: `# Onboarding trainer

Il primo accesso deve portare il trainer al primo cliente aggiunto in meno di tre minuti. Tutto il resto è rimandato.

## Passaggi

- Crea account e conferma email
- Imposta specializzazione e fuso orario
- Genera il primo codice invito dalla home del pannello

## Tono dei messaggi

> "Ciao, Coach 👋 — iniziamo dal tuo primo cliente."

Dare del tu, frasi brevi, mai gergo tecnico. Vedi [tono-di-voce.md](tono-di-voce.md).

## Metrica

Attivazione = primo cliente aggiunto entro 24 h dall'iscrizione.
`,
  },
  {
    path: 'Athly Dashboard/tono-di-voce.md',
    ago: 1 * D + 3 * H,
    content: `# Tono di voce

Parliamo come un collega esperto, non come un software.

- Dare del tu
- Frasi brevi, verbi attivi
- Mai gergo tecnico nei messaggi al trainer
`,
  },
  {
    path: 'Athly Dashboard/glossario.md',
    ago: 4 * D,
    content: `# Glossario

- **Cliente** — atleta seguito dal trainer.
- **Programma** — ciclo di allenamento con data di scadenza.
- **Codice invito** — stringa di 8 caratteri che aggancia l'app atleta al trainer.
- **Scheda** — singola sessione dentro un programma.

Il codice invito scade dopo 7 giorni. Un codice invito già usato non può essere riassegnato.
`,
  },
  {
    path: 'Athly Dashboard/architettura/frontend.md',
    ago: 6 * D,
    content: `# Frontend

React 18 + TypeScript. Routing e componenti da Framework7, grafici con MUI X Charts.

## Stato

- Server state con React Query
- Stato locale con \`useReducer\`
`,
  },
  { path: 'Athly Dashboard/architettura/stato.md', ago: 6 * D, content: `# Stato applicativo\n\nNiente store globale: React Query per i dati remoti.\n` },
  { path: 'Athly Dashboard/architettura/temi.md', ago: 9 * D, content: `# Temi\n\nDark-first. I token vivono in \`color.css\`.\n` },
  { path: 'Athly Dashboard/architettura/build.md', ago: 12 * D, content: `# Build\n\nVite, output statico su CDN.\n` },
  { path: 'Athly Dashboard/decisioni/adr-001-framework7.md', ago: 20 * D, content: `# ADR 001 — Framework7\n\nScelto per la resa nativa su mobile web.\n` },
  { path: 'Athly Dashboard/decisioni/adr-002-react-query.md', ago: 18 * D, content: `# ADR 002 — React Query\n\nCache server-side e revalidazione automatica.\n` },
  { path: 'Athly Dashboard/decisioni/adr-003-tema-scuro.md', ago: 10 * D, content: `# ADR 003 — Tema scuro di default\n\nIl pubblico usa il pannello in palestra, spesso con poca luce.\n` },
  { path: 'Athly Dashboard/decisioni/adr-004-grafici.md', ago: 8 * D, content: `# ADR 004 — Grafici\n\nMUI X Charts al posto di Chart.js.\n` },
  { path: 'Athly Dashboard/decisioni/adr-005-pdf.md', ago: 3 * D, content: `# ADR 005 — Export PDF\n\nGenerazione lato server.\n` },
  { path: 'Athly Dashboard/decisioni/archivio/adr-000-jquery.md', ago: 40 * D, content: `# ADR 000 — jQuery\n\nSuperata da ADR 001.\n` },

  // ── Sito Athly ─────────────────────────────────────────────────────────────
  {
    path: 'Sito Athly/checklist.md',
    ago: 1 * D,
    content: `## Lancio

- [x] Hero con video
- [x] Sezione prezzi
- [x] Form contatti
- [x] Cookie banner
- [x] Open Graph
- [x] Sitemap
- [ ] Blog
- [ ] Pagina casi studio
- [ ] Traduzione EN
- [ ] A/B test hero
- [ ] Pagina carriere
- [ ] Integrazione CRM
- [ ] Analytics eventi
- [ ] Test velocità mobile
- [ ] Revisione legale
`,
  },
  { path: 'Sito Athly/pagine/home.md', ago: 1 * D, content: `# Home\n\nMessaggio principale: "Allena di più, amministra di meno."\n` },
  { path: 'Sito Athly/pagine/prezzi.md', ago: 2 * D, content: `# Prezzi\n\nTre piani: Starter, Pro, Studio.\n\n| Piano | Clienti | Prezzo/mese | Note |\n|:------|:-------:|------------:|------|\n| **Starter** | 10 | 19 € | Solo app |\n| **Pro** | 50 | 49 € | Export PDF, \`API\` |\n| **Studio** | illimitati | 99 € | Più trainer, [SEO](../seo.md) |\n` },
  { path: 'Sito Athly/pagine/contatti.md', ago: 5 * D, content: `# Contatti\n\nForm con invio a HubSpot.\n` },
  { path: 'Sito Athly/seo.md', ago: 3 * D, content: `# SEO\n\nParole chiave: gestionale personal trainer, app allenamento clienti.\n` },
  { path: 'Sito Athly/deploy.md', ago: 6 * D, content: `# Deploy\n\nCloudflare Pages dal branch \`main\`.\n` },
  { path: 'Sito Athly/copy.md', ago: 7 * D, content: `# Copy\n\nVedi Brand & voce.\n` },

  // ── Server & API ───────────────────────────────────────────────────────────
  {
    path: 'Server & API/endpoint.md',
    ago: 1 * D + 5 * H,
    content: `# Endpoint

## Inviti

POST /invite — genera un codice invito valido 7 giorni e lo associa al trainer.

GET /invite/:code — verifica un codice invito dall'app atleta.

## Clienti

GET /clients — elenco paginato.
`,
  },
  { path: 'Server & API/autenticazione.md', ago: 3 * D, content: `# Autenticazione\n\nJWT con refresh token ruotato.\n` },
  { path: 'Server & API/job.md', ago: 3 * D, content: `# Job in background\n\nBullMQ su Redis per email e PDF.\n` },
  { path: 'Server & API/database.md', ago: 4 * D, content: `# Database\n\nPostgres 16, migrazioni con Drizzle.\n` },
  { path: 'Server & API/errori.md', ago: 5 * D, content: `# Errori\n\nFormato RFC 7807.\n` },
  { path: 'Server & API/rate-limit.md', ago: 6 * D, content: `# Rate limit\n\n100 richieste/minuto per trainer.\n` },

  // ── Brand & voce ───────────────────────────────────────────────────────────
  { path: 'Brand & voce/colori.md', ago: 7 * D, content: `# Colori\n\n- Viola \`#8f5cff\`\n- Blu \`#3a86ff\`\n- Scuro \`#141413\`\n` },
  { path: 'Brand & voce/logo.md', ago: 8 * D, content: `# Logo\n\nMai su sfondi con gradiente.\n` },
  { path: 'Brand & voce/voce.md', ago: 7 * D, content: `# Voce\n\nDiretta, calda, competente.\n` },
  { path: 'Brand & voce/tipografia.md', ago: 9 * D, content: `# Tipografia\n\nInter, pesi 400–700.\n` },

  // ── Ricerca LLM ────────────────────────────────────────────────────────────
  { path: 'Ricerca LLM/prompt-onboarding.md', ago: 14 * D, content: `# Prompt onboarding\n\nPrompt per generare il primo programma dal questionario.\n` },
  { path: 'Ricerca LLM/valutazioni.md', ago: 15 * D, content: `# Valutazioni\n\nSet di 50 questionari annotati.\n` },
  { path: 'Ricerca LLM/costi.md', ago: 15 * D, content: `# Costi\n\nStima per 1000 trainer attivi.\n` },
  { path: 'Ricerca LLM/esperimenti/exp-01.md', ago: 16 * D, content: `# Esperimento 01\n\nFew-shot vs zero-shot.\n` },
  { path: 'Ricerca LLM/esperimenti/exp-02.md', ago: 16 * D, content: `# Esperimento 02\n\nOutput strutturato JSON.\n` },
  { path: 'Ricerca LLM/esperimenti/exp-03.md', ago: 17 * D, content: `# Esperimento 03\n\nLunghezza del contesto.\n` },
  { path: 'Ricerca LLM/memoria.md', ago: 18 * D, content: `# Memoria\n\nLa knowledge base come memoria condivisa fra agenti.\n` },
  { path: 'Ricerca LLM/sicurezza.md', ago: 19 * D, content: `# Sicurezza\n\nPrompt injection nei documenti condivisi.\n` },
  { path: 'Ricerca LLM/strumenti.md', ago: 20 * D, content: `# Strumenti\n\nMCP per lettura e scrittura della base.\n` },
];

export const seedAgents: (Omit<Agent, 'connectedAt' | 'lastSeenAt'> & { seenAgo: number | null })[] = [
  { id: 'claude', name: 'Claude', initials: 'CL', color: '#8f5cff', permission: 'read-write', seenAgo: 2 * M },
  { id: 'codex', name: 'Codex', initials: 'CX', color: '#3a86ff', permission: 'read-write', seenAgo: 2 * H },
  { id: 'gpt', name: 'GPT Desktop', initials: 'GP', color: null, permission: 'read', seenAgo: 1 * D },
  { id: 'cursor', name: 'Cursor', initials: 'CU', color: null, permission: 'read', seenAgo: null },
];

const INDEX_BEFORE = `# Athly Dashboard

Pannello web per personal trainer: clienti, programmi e metriche. React + TypeScript su Framework7.

## Struttura

\`\`\`
architettura/   4 file
decisioni/      5 file
onboarding.md
tono-di-voce.md
glossario.md
\`\`\`

## Concetti chiave

- \`Cliente\` — persona seguita
- \`Programma\` — ciclo con scadenza
`;

export const seedChanges: (Omit<Change, 'at' | 'after' | 'added' | 'removed'> & { ago: number; after?: string })[] = [
  {
    id: 'chg-index',
    agentId: 'claude',
    path: 'Athly Dashboard/index.md',
    project: 'Athly Dashboard',
    ago: 2 * M,
    automatic: true,
    before: INDEX_BEFORE,
    restorable: true,
  },
  {
    id: 'chg-endpoint',
    agentId: 'gpt',
    path: 'Server & API/endpoint.md',
    project: 'Server & API',
    ago: 1 * D + 5 * H,
    automatic: false,
    before: '',
    restorable: false,
  },
  {
    id: 'chg-checklist',
    agentId: 'codex',
    path: 'Athly Dashboard/checklist.md',
    project: 'Athly Dashboard',
    ago: 2 * H,
    automatic: false,
    before: '', // filled at seed time from current content
    restorable: true,
  },
];

export const seedActivity: (Omit<ActivityEvent, 'at'> & { ago: number })[] = [
  { id: 'ev-1', agentId: 'claude', kind: 'write', project: 'Athly Dashboard', path: 'Athly Dashboard/index.md', ago: 2 * M, changeId: 'chg-index' },
  { id: 'ev-2', agentId: 'codex', kind: 'check', project: 'Athly Dashboard', path: 'Athly Dashboard/checklist.md', ago: 2 * H, count: 2, changeId: 'chg-checklist' },
  { id: 'ev-3', agentId: 'claude', kind: 'read', project: 'Server & API', path: null, ago: 5 * H, count: 6 },
  { id: 'ev-4', agentId: 'gpt', kind: 'create', project: 'Server & API', path: 'Server & API/endpoint.md', ago: 1 * D + 5 * H, changeId: 'chg-endpoint' },
];

export const seedRecentSearches = ['codice invito', 'tono di voce', 'breakpoint sidebar'];

export const seedRecentFiles: { path: string; ago: number }[] = [
  { path: 'Athly Dashboard/onboarding.md', ago: 2 * M },
  { path: 'Athly Dashboard/glossario.md', ago: 3 * H },
  { path: 'Server & API/endpoint.md', ago: 5 * H },
];
