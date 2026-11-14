# Study mode API

The study mode ("Modalità studio" in the mobile app) runs on its own AWS Lambda,
`study-lambda/`, behind a Function URL that streams its responses as
server-sent events. The Worker is unchanged: the Lambda reads the notes and
writes the report **through the Worker's `/v1` routes with the caller's own
Cognito token**, so team roles, `index.md`, the change cursor and search apply
exactly as for any other client write. Why a separate Lambda: see
[ARCHITECTURE_DECISIONS §9](ARCHITECTURE_DECISIONS.md#9-study-mode-on-a-separate-aws-lambda).

**The apps call the Worker, not the Lambda:** `POST /v1/study-mode/generate` and
`POST /v1/study-mode/grade` on the usual API base URL (`src/api/study.ts`). The
Worker checks the token, forwards body and token to `STUDY_LAMBDA_URL` and
passes the event stream through unchanged (bodies ≤ 1 MB; 503 while
`STUDY_LAMBDA_URL` is unset, 502 if the Lambda is unreachable). The routes below
are the Lambda's own paths.

The app keeps a copy of the types in `src/api/study/types.ts`; this file is the
contract between the two. Change both together.

## Authentication

`Authorization: Bearer <Cognito ID or access token>`, same pool and app clients
as the Worker. The token is verified in the Lambda (`aws-jwt-verify`) and then
forwarded unchanged to the Worker.

Errors **before** the stream opens are JSON `{ "error": "…" }`:
`401` (missing/invalid token), `400` (body), `404`, `405`.
Once the stream is open the status is `200` and a failure is an `error` event.

## Events

`Content-Type: text/event-stream`. Every event is `event: <name>\ndata: <json>\n\n`.
A `: ping` comment arrives every 15 s on a quiet stream. The stream always ends
with `done` or `error`.

| Event | Data |
|---|---|
| `file` | `{ path, status: "loading"\|"ready"\|"skipped", kind: "markdown"\|"pdf"\|"image"\|"unsupported", bytes?, reason? }` |
| `topics` | `{ topics: string[] }` |
| `question` | `{ question: Question, index, total }` |
| `graded` | `QuestionResult` |
| `result` | `SessionResult` |
| `saved` | `{ path }` — the report note written |
| `save_failed` | `{ message }` — the result above still stands (e.g. a viewer of a team project) |
| `done` | `{}` or `{ count }` |
| `error` | `{ code, message }` — `code`: `unauthorized`, `invalid`, `not_found`, `forbidden`, `too_large`, `refusal`, `incomplete`, `model`, `upstream`, `internal` |

## `POST /generate`

```jsonc
{
  "sources": [{ "path": "Analisi 1/lezione-04-serie.pdf", "owner": "t:<teamId>" /* optional */ }],
  "mix": { "mc": 4, "tf": 4, "open": 2 },        // 1…30 in total, ≤ 20 per type
  "difficulty": "ripasso" | "esame" | "orale",   // tone of the questions (default esame)
  "citeSource": true,                            // false: questions carry source = null
  "instructions": "Sii severo come all'orale…"   // optional, ≤ 2000 chars
}
```

Sources: `.md` notes (`GET /v1/file`), PDFs and png/jpg/gif/webp images
(`GET /v1/blob`), read by the model directly — no OCR step. SVG is skipped. At
most 12 files and 20 MB in total. Events: `file`×, `topics`, `question`×N, `done`.

```ts
type Question = { id: string; topic: string; prompt: string; source: { path; locator; excerpt } | null } & (
  | { type: 'mc'; options: [string, string, string, string]; correctIndex: 0 | 1 | 2 | 3; explanation: string }
  | { type: 'tf'; correct: boolean; explanation: string }
  | { type: 'open'; expectedPoints: string[] }
);
```

The Lambda is stateless: the app keeps the questions (answer key included) and
sends them back to `/grade`.

## `POST /grade`

```jsonc
{
  "project": "Analisi 1",                 // the report goes to <project>/studio/ in `owner`'s space
  "owner": "t:<teamId>",                  // optional
  "questions": [ /* Question[] as received */ ],
  "answers": { "q1": { "choice": 1 }, "q5": { "value": false, "motivation": "…" }, "q9": { "text": "…" } },
  "criteria": [{ "id": "rigore", "name": "Rigore", "description": "Definizioni e ipotesi esatte", "weight": 40 }],
  "instructions": "…",
  "scale": "30" | "10" | "percent" | "judgement",
  "difficulty": "esame",
  "presetName": "Orale Analisi",          // optional, shown in the report
  "date": "2026-11-14",                   // the user's local day, for the file name
  "durationSec": 840,
  "sources": [{ "path": "…" }]            // listed in the report
}
```

Weights sum to 100; open questions need at least one criterion.
Events: `graded`× (closed answers at once, model-graded ones as they finish), `result`, `saved` | `save_failed`, `done`.

### Scoring (done by the Lambda, never by the model)

- multiple choice: 1 or 0; true/false: 1 or 0, and with a motivation 70% the answer + 30% the motivation;
- open: Σ(weight × criterion score 0–10) / Σ weight / 10;
- empty: 0. The model only scores each criterion of each open answer / motivation and writes the comments.
- grade = mean of the question scores on the chosen scale (`/30`, `/10` with one decimal, `%`, or a judgement:
  Insufficiente < 50% ≤ Sufficiente < 60% ≤ Discreto < 70% ≤ Buono < 80% ≤ Distinto < 90% ≤ Ottimo).

```ts
interface QuestionResult { questionId; status: 'correct'|'wrong'|'partial'|'empty'; score /* 0…1 */;
  criterionScores?: Record<string, number>; comment?; highlights?: { quote; kind: 'good'|'wrong' }[] }
interface SessionResult { grade: { fraction; label; suffix }; scale; headline; subline; closedCorrect; closedTotal;
  openAverage /* 0…10 | null */; durationSec; criteria: { id; name; weight; score /* 0…10 | null */; note }[];
  questions: QuestionResult[]; topics: string[] }
```

Highlights are verbatim quotes of the answer; the Lambda drops any that aren't.

### The report

`<project>/studio/YYYY-MM-DD-<first-topic>.md` (`-2`, `-3`… if taken), never
overwritten. A readable note (grade, criteria, every question with answer,
solution, comment and source as `[[wiki links]]`) ending with a
```` ```lore-study ```` fenced JSON block — the app reads that block to draw the
trend and the list of saved sessions:

```ts
{ v: 1, date, grade: { label, suffix, fraction }, scale, headline, topics, closedCorrect, closedTotal,
  openAverage, durationSec, preset?, criteria: { name, weight, score }[],
  questions: { id, type, topic, status, score }[], sources: string[] }
```

## Model

Anthropic Messages API, `claude-sonnet-5-5` by default (`STUDY_MODEL`), effort
`medium`, server-side fallback on a policy decline (`fallbacks: "default"`).
Questions and grades come back as strict tool calls, one per question/answer,
validated with zod; a bad call is returned as an error tool result and asked
again, for at most 4 requests per call. The sources are prompt-cached.

## Deploy

`study-lambda/scripts/deploy.sh` (plain AWS CLI, idempotent) or `sam deploy`
(`template.yaml`). The Anthropic key is the SSM SecureString `/ai/anthropic-api-key`,
read once per container. Then set `STUDY_LAMBDA_URL` in `wrangler.toml`. See the
README, "Study mode".
