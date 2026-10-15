import * as cl from './checklist';
import { insertAudit, type AuditAction } from '../db/audit';
import { bumpVersion } from '../db/version';
import type { AgentContext } from '../env';
import { scopeAllows } from '../permissions/scope';
import { PathError, isMarkdown, parseFolder, parsePath, parseProject } from '../storage/paths';
import type { Store } from '../storage/store';

/** A failure the agent should see as a normal tool result (isError), not a protocol error. */
export class ToolError extends Error {}

export interface ToolContext {
  agent: AgentContext;
  store: Store;
  db: D1Database;
  waitUntil: (p: Promise<unknown>) => void;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  run: (args: Record<string, unknown>, c: ToolContext) => Promise<string>;
}

const pathProp = {
  type: 'string',
  description: 'File path relative to your knowledge base: "<project>/<folder>/<file>.md".',
};

function canRead(a: AgentContext, project: string): void {
  if (!scopeAllows(a.projectScope, project)) throw new ToolError(`No access to project "${project}".`);
}

function canWrite(a: AgentContext, project: string): void {
  canRead(a, project);
  if (a.accessLevel !== 'read_write') throw new ToolError('This agent is read-only.');
}

const MAX_SEARCH_RESULTS = 50;

function intArg(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new ToolError(`"${key}" must be a positive integer.`);
  return v;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new ToolError(`"${key}" must be a string.`);
  return v;
}

/** Index regeneration inline (so a following read sees it); audit async so it never blocks the agent. */
async function afterModification(
  c: ToolContext,
  project: string,
  action: AuditAction,
  rel: string,
): Promise<void> {
  await c.store.compileIndex(c.agent.userId, project);
  // The user's clients poll this cursor to pick up the change.
  await bumpVersion(c.db, c.agent.userId).catch((err) => console.error('version bump failed', String(err)));
  c.waitUntil(
    insertAudit(c.db, { userId: c.agent.userId, agentId: c.agent.agentId, action, targetPath: rel }).catch((err) =>
      console.error('audit insert failed', { agentId: c.agent.agentId, action, rel, err: String(err) }),
    ),
  );
}

const checklistPath = (project: string) => `${project}/checklist.md`;

/** A project name argument, checked against the agent's scope. */
function projectArg(args: Record<string, unknown>, c: ToolContext, key = 'project', write = false): string {
  const project = parseProject(args[key]);
  if (write) canWrite(c.agent, project);
  else canRead(c.agent, project);
  return project;
}

const projectProp = { type: 'string', description: 'Project name (see list_projects).' };
const itemProp = { type: 'string', description: 'Partial text of the checklist item (case-insensitive).' };

/** Shared body of the checklist mutations: atomically rewrite `<project>/checklist.md`. */
async function mutateChecklist(
  c: ToolContext,
  project: string,
  fn: (content: string) => { content: string; count: number },
  none: string,
): Promise<number> {
  let count = 0;
  const found = await c.store.modify(c.agent.userId, checklistPath(project), (content) => {
    const r = fn(content);
    count = r.count;
    return r.content;
  });
  if (!found) throw new ToolError(`Checklist not found for "${project}".`);
  if (count === 0) throw new ToolError(none);
  await afterModification(c, project, 'UPDATE', checklistPath(project));
  return count;
}

function rejectIndex(isIndex: boolean): void {
  if (isIndex) throw new ToolError('index.md is generated automatically and cannot be modified.');
}

export const tools: ToolDef[] = [
  {
    name: 'list_projects',
    description: 'List the projects this agent can access.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(_args, c) {
      const all = await c.store.listProjects(c.agent.userId);
      return JSON.stringify(all.filter((p) => scopeAllows(c.agent.projectScope, p)));
    },
  },
  {
    name: 'list_files',
    description: 'List all files of a project (optionally only inside a folder). Start from "<project>/index.md" for an overview.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        folder: { type: 'string', description: 'Optional folder inside the project.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args, c) {
      const project = parseProject(args.project);
      canRead(c.agent, project);
      const files = await c.store.listFiles(c.agent.userId, project, parseFolder(args.folder));
      // Images/PDFs the user attached are listed so links make sense, but they are not readable as text.
      return JSON.stringify(files.map((f) => (isMarkdown(f.path) ? f : { ...f, attachment: true })));
    },
  },
  {
    name: 'read_file',
    description: 'Read a markdown file.',
    inputSchema: { type: 'object', properties: { path: pathProp }, required: ['path'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(args, c) {
      const p = parsePath(args.path, { attachments: true });
      canRead(c.agent, p.project);
      if (p.kind === 'attachment') throw new ToolError(`${p.rel} is a binary attachment (${p.contentType}) and cannot be read as text.`);
      const content = await c.store.read(c.agent.userId, p.rel);
      if (content === null) throw new ToolError(`File not found: ${p.rel}`);
      return content;
    },
  },
  {
    name: 'write_file',
    description:
      'Create a markdown file, or replace it when overwrite=true. Creating the first file of a project creates the project. ' +
      'Prefer append_file for checklist.md.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathProp,
        content: { type: 'string' },
        overwrite: { type: 'boolean', description: 'Replace the file if it exists (default false).' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async run(args, c) {
      const p = parsePath(args.path);
      rejectIndex(p.isIndex);
      canWrite(c.agent, p.project);
      const action = await c.store.write(c.agent.userId, p.rel, str(args, 'content'), args.overwrite === true);
      await afterModification(c, p.project, action, p.rel);
      return `${action === 'CREATE' ? 'Created' : 'Updated'} ${p.rel}`;
    },
  },
  {
    name: 'append_file',
    description: 'Append text to a markdown file (created if missing). Safe against concurrent edits.',
    inputSchema: {
      type: 'object',
      properties: { path: pathProp, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async run(args, c) {
      const p = parsePath(args.path);
      rejectIndex(p.isIndex);
      canWrite(c.agent, p.project);
      const action = await c.store.append(c.agent.userId, p.rel, str(args, 'content'));
      await afterModification(c, p.project, action, p.rel);
      return `Appended to ${p.rel}`;
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a markdown file. This cannot be undone.',
    inputSchema: { type: 'object', properties: { path: pathProp }, required: ['path'], additionalProperties: false },
    annotations: { destructiveHint: true },
    async run(args, c) {
      const p = parsePath(args.path);
      rejectIndex(p.isIndex);
      canWrite(c.agent, p.project);
      if (!(await c.store.delete(c.agent.userId, p.rel))) throw new ToolError(`File not found: ${p.rel}`);
      await afterModification(c, p.project, 'DELETE', p.rel);
      return `Deleted ${p.rel}`;
    },
  },
  {
    name: 'read_file_lines',
    description: 'Read a range of lines (1-based, inclusive) of a markdown file. Lines are returned with their numbers, ready for patch_file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathProp,
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1, description: 'Omit to read to the end of the file.' },
      },
      required: ['path', 'startLine'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args, c) {
      const p = parsePath(args.path);
      canRead(c.agent, p.project);
      const content = await c.store.read(c.agent.userId, p.rel);
      if (content === null) throw new ToolError(`File not found: ${p.rel}`);
      const lines = content.split('\n');
      const start = intArg(args, 'startLine');
      const end = Math.min(args.endLine === undefined ? lines.length : intArg(args, 'endLine'), lines.length);
      if (start > lines.length) throw new ToolError(`startLine (${start}) is past the end of the file (${lines.length} lines).`);
      if (start > end) throw new ToolError(`startLine (${start}) must be <= endLine (${end}).`);
      const body = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n');
      return `${p.rel} — lines ${start}–${end} of ${lines.length}:\n\n${body}`;
    },
  },
  {
    name: 'search_files',
    description: 'Search a keyword or phrase (case-insensitive) in all markdown files of the projects this agent can access, optionally only in one project.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, project: { type: 'string', description: 'Optional: search only this project.' } },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async run(args, c) {
      const query = str(args, 'query').toLowerCase();
      if (query === '') throw new ToolError('"query" must not be empty.');
      const projects =
        args.project === undefined
          ? (await c.store.listProjects(c.agent.userId)).filter((p) => scopeAllows(c.agent.projectScope, p))
          : [projectArg(args, c)];
      const results: { path: string; snippet: string }[] = [];
      for (const project of projects) {
        for (const f of await c.store.listFiles(c.agent.userId, project)) {
          if (!isMarkdown(f.path) || f.path.toLowerCase() === 'index.md') continue;
          const content = await c.store.read(c.agent.userId, `${project}/${f.path}`);
          const idx = content?.toLowerCase().indexOf(query) ?? -1;
          if (content === null || idx === -1) continue;
          results.push({ path: `${project}/${f.path}`, snippet: content.slice(Math.max(0, idx - 150), idx + 300).trim() });
          if (results.length >= MAX_SEARCH_RESULTS) break;
        }
        if (results.length >= MAX_SEARCH_RESULTS) break;
      }
      return results.length === 0 ? `No results for: "${str(args, 'query')}"` : JSON.stringify(results);
    },
  },
  {
    name: 'patch_file',
    description:
      'Replace a range of lines (1-based, inclusive) of an existing markdown file with new content. Use read_file_lines first to see line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathProp,
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        newContent: { type: 'string', description: 'Text replacing the selected lines (may contain newlines).' },
      },
      required: ['path', 'startLine', 'endLine', 'newContent'],
      additionalProperties: false,
    },
    async run(args, c) {
      const p = parsePath(args.path);
      rejectIndex(p.isIndex);
      canWrite(c.agent, p.project);
      const start = intArg(args, 'startLine');
      const end = intArg(args, 'endLine');
      const replacement = str(args, 'newContent').split('\n');
      if (start > end) throw new ToolError(`startLine (${start}) must be <= endLine (${end}).`);
      let summary = '';
      const found = await c.store.modify(c.agent.userId, p.rel, (content) => {
        const lines = content.split('\n');
        if (start > lines.length) throw new ToolError(`startLine (${start}) is past the end of the file (${lines.length} lines).`);
        const clamped = Math.min(end, lines.length);
        summary = `Patched ${p.rel}: lines ${start}–${clamped} (${clamped - start + 1}) replaced with ${replacement.length} lines.`;
        return [...lines.slice(0, start - 1), ...replacement, ...lines.slice(clamped)].join('\n');
      });
      if (!found) throw new ToolError(`File not found: ${p.rel}`);
      await afterModification(c, p.project, 'UPDATE', p.rel);
      return summary;
    },
  },
  {
    name: 'get_checklist',
    description: 'Read the checklist of a project (`<project>/checklist.md`) with a completed/total summary.',
    inputSchema: { type: 'object', properties: { project: projectProp }, required: ['project'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(args, c) {
      const project = projectArg(args, c);
      const content = await c.store.read(c.agent.userId, checklistPath(project));
      if (content === null) throw new ToolError(`Checklist not found for "${project}".`);
      const items = cl.parseChecklist(content);
      return `Checklist: ${items.filter((i) => i.checked).length}/${items.length} completed\n\n${content}`;
    },
  },
  {
    name: 'add_checklist_item',
    description:
      'Add an item to a project checklist (created if missing). With a version, the item goes in that "## version" section, created if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectProp,
        item: { type: 'string', description: 'Text of the new item.' },
        version: { type: 'string', description: 'Optional version section, e.g. "v1.2.0". Default: end of file.' },
        checked: { type: 'boolean', description: 'Add it already completed (default false).' },
      },
      required: ['project', 'item'],
      additionalProperties: false,
    },
    async run(args, c) {
      const project = projectArg(args, c, 'project', true);
      const item = str(args, 'item');
      if (/[\r\n]/.test(item) || item.trim() === '') throw new ToolError('"item" must be a single non-empty line.');
      const version = args.version === undefined ? undefined : str(args, 'version');
      if (version !== undefined && (/[\r\n]/.test(version) || version.trim() === '')) throw new ToolError('"version" must be a single non-empty line.');
      const rel = checklistPath(project);
      const add = (content: string | null) => cl.addItem(content, project, item, version?.trim(), args.checked === true);
      if (!(await c.store.modify(c.agent.userId, rel, add))) {
        // Missing: create it, but never overwrite a checklist created by someone in the meantime.
        await c.store.write(c.agent.userId, rel, add(null), false).catch(async (err) => {
          if (!(await c.store.exists(c.agent.userId, rel))) throw err;
          await c.store.modify(c.agent.userId, rel, add);
        });
      }
      await afterModification(c, project, 'UPDATE', rel);
      return `Added to the checklist of "${project}" (${version ? `version "${version}"` : 'end of file'}): ${item}`;
    },
  },
  {
    name: 'check_item',
    description: 'Mark checklist items as completed or not completed (partial, case-insensitive text match; all matches are changed).',
    inputSchema: {
      type: 'object',
      properties: { project: projectProp, item: itemProp, checked: { type: 'boolean', description: 'true = completed (default), false = to do.' } },
      required: ['project', 'item'],
      additionalProperties: false,
    },
    async run(args, c) {
      const project = projectArg(args, c, 'project', true);
      const item = str(args, 'item');
      const checked = args.checked !== false;
      const n = await mutateChecklist(c, project, (t) => cl.setChecked(t, item, checked), `No item matching "${item}" in the checklist of "${project}".`);
      return `${n} item(s) marked as ${checked ? 'completed' : 'not completed'}.`;
    },
  },
  {
    name: 'edit_checklist_item',
    description: 'Change the text of checklist items (partial, case-insensitive match), keeping their checked state.',
    inputSchema: {
      type: 'object',
      properties: { project: projectProp, item: itemProp, newText: { type: 'string', description: 'New text of the item.' } },
      required: ['project', 'item', 'newText'],
      additionalProperties: false,
    },
    async run(args, c) {
      const project = projectArg(args, c, 'project', true);
      const item = str(args, 'item');
      const newText = str(args, 'newText');
      if (/[\r\n]/.test(newText) || newText.trim() === '') throw new ToolError('"newText" must be a single non-empty line.');
      const n = await mutateChecklist(c, project, (t) => cl.editItem(t, item, newText), `No item matching "${item}" in the checklist of "${project}".`);
      return `${n} item(s) updated with text "${newText}".`;
    },
  },
  {
    name: 'delete_checklist_item',
    description: 'Remove checklist items (partial, case-insensitive match; all matches are removed). This cannot be undone.',
    inputSchema: { type: 'object', properties: { project: projectProp, item: itemProp }, required: ['project', 'item'], additionalProperties: false },
    annotations: { destructiveHint: true },
    async run(args, c) {
      const project = projectArg(args, c, 'project', true);
      const item = str(args, 'item');
      const n = await mutateChecklist(c, project, (t) => cl.deleteItems(t, item), `No item matching "${item}" in the checklist of "${project}".`);
      return `${n} item(s) removed from the checklist of "${project}".`;
    },
  },
  {
    name: 'move_checklist_item',
    description: 'Move checklist items from one version section to another (partial, case-insensitive match). The target section is created if missing.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectProp,
        item: itemProp,
        fromVersion: { type: 'string', description: 'Source version, e.g. "v1.0.0".' },
        toVersion: { type: 'string', description: 'Destination version, e.g. "v1.1.0".' },
      },
      required: ['project', 'item', 'fromVersion', 'toVersion'],
      additionalProperties: false,
    },
    async run(args, c) {
      const project = projectArg(args, c, 'project', true);
      const [item, from, to] = [str(args, 'item'), str(args, 'fromVersion').trim(), str(args, 'toVersion').trim()];
      if (!to || /[\r\n]/.test(to)) throw new ToolError('"toVersion" must be a single non-empty line.');
      const n = await mutateChecklist(c, project, (t) => cl.moveItems(t, item, from, to), `No item matching "${item}" in version "${from}".`);
      return `${n} item(s) moved from "${from}" to "${to}" in the checklist of "${project}".`;
    },
  },
  {
    name: 'create_project',
    description:
      'Create a new, empty project (with a starter overview.md). Fails if the project already exists. Project names: letters, digits, spaces, "_", ".", "-" (max 64).',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Name of the new project.' } },
      required: ['project'],
      additionalProperties: false,
    },
    async run(args, c) {
      const project = projectArg(args, c, 'project', true);
      if ((await c.store.listFiles(c.agent.userId, project)).length > 0) throw new ToolError(`Project already exists: ${project}`);
      await c.store.write(c.agent.userId, `${project}/overview.md`, `# ${project}\n`, false);
      await afterModification(c, project, 'CREATE', `${project}/overview.md`);
      return `Created project ${project}`;
    },
  },
  {
    name: 'rename_project',
    description:
      'Rename a project, moving all its files. Fails if the new name is taken. The agent needs access to both names; other agents scoped to the old name lose access.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Current name.' }, newName: { type: 'string', description: 'New name.' } },
      required: ['project', 'newName'],
      additionalProperties: false,
    },
    async run(args, c) {
      const from = projectArg(args, c, 'project', true);
      const to = projectArg(args, c, 'newName', true);
      if (from === to) throw new ToolError('The new name is the same as the current one.');
      const moved = await c.store.renameProject(c.agent.userId, from, to);
      await afterModification(c, to, 'CREATE', `${to}/`);
      c.waitUntil(
        insertAudit(c.db, { userId: c.agent.userId, agentId: c.agent.agentId, action: 'DELETE', targetPath: `${from}/` }).catch((err) =>
          console.error('audit insert failed', String(err)),
        ),
      );
      return `Renamed project ${from} to ${to} (${moved} files moved)`;
    },
  },
  {
    name: 'delete_project',
    description: 'Delete a project and ALL its files. This cannot be undone. Requires confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { project: projectProp, confirm: { type: 'boolean', description: 'Must be true.' } },
      required: ['project', 'confirm'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    async run(args, c) {
      const project = projectArg(args, c, 'project', true);
      if (args.confirm !== true) throw new ToolError('Set confirm=true to delete the project and all its files.');
      const n = await c.store.deleteProject(c.agent.userId, project);
      if (n === 0) throw new ToolError(`Project not found: ${project}`);
      await bumpVersion(c.db, c.agent.userId).catch((err) => console.error('version bump failed', String(err)));
      c.waitUntil(
        insertAudit(c.db, { userId: c.agent.userId, agentId: c.agent.agentId, action: 'DELETE', targetPath: `${project}/` }).catch((err) =>
          console.error('audit insert failed', String(err)),
        ),
      );
      return `Deleted project ${project} (${n} files)`;
    },
  },
];

export function toolDescriptors() {
  return tools.map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
  }));
}

export async function callTool(name: string, args: unknown, c: ToolContext) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return null;
  try {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new ToolError('Arguments must be an object.');
    const text = await tool.run(args as Record<string, unknown>, c);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    if (err instanceof ToolError || err instanceof PathError) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    console.error('tool failure', { name, err: String(err) });
    return { content: [{ type: 'text', text: 'Internal error.' }], isError: true };
  }
}
