import { insertAudit, type AuditAction } from '../db/audit';
import type { AgentContext } from '../env';
import { scopeAllows } from '../permissions/scope';
import { PathError, parseFolder, parsePath, parseProject } from '../storage/paths';
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
  c.waitUntil(
    insertAudit(c.db, { userId: c.agent.userId, agentId: c.agent.agentId, action, targetPath: rel }).catch((err) =>
      console.error('audit insert failed', { agentId: c.agent.agentId, action, rel, err: String(err) }),
    ),
  );
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
      return JSON.stringify(await c.store.listFiles(c.agent.userId, project, parseFolder(args.folder)));
    },
  },
  {
    name: 'read_file',
    description: 'Read a markdown file.',
    inputSchema: { type: 'object', properties: { path: pathProp }, required: ['path'], additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(args, c) {
      const p = parsePath(args.path);
      canRead(c.agent, p.project);
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
