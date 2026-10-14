import type { AccessLevel } from '../env';
import { PathError, parseProject } from '../storage/paths';

/** A scope is `*` or `Project/*`; a comma-separated list is allowed (`A/*,B/*`). */
export function parseScope(scope: string): string[] {
  return scope
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function validateScope(scope: unknown): string {
  if (typeof scope !== 'string' || scope.trim() === '') throw new PathError('project_scope is required');
  const parts = parseScope(scope);
  if (parts.length === 0 || parts.length > 20) throw new PathError('project_scope must contain 1-20 entries');
  for (const part of parts) {
    if (part === '*') continue;
    if (!part.endsWith('/*')) throw new PathError(`Invalid scope entry "${part}" (use "*" or "Project/*")`);
    parseProject(part.slice(0, -2));
  }
  return parts.join(',');
}

export function scopeAllows(scope: string, project: string): boolean {
  return parseScope(scope).some((p) => p === '*' || p === `${project}/*`);
}

export const MAX_AGENTS_PER_USER = 20;

export const AGENT_TYPES = ['claude', 'codex'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export function validateAgentType(type: unknown): AgentType {
  if (!AGENT_TYPES.includes(type as AgentType)) throw new PathError(`agent_type must be one of: ${AGENT_TYPES.join(', ')}`);
  return type as AgentType;
}

export function validateAccessLevel(level: unknown): AccessLevel {
  if (level !== 'read_only' && level !== 'read_write') {
    throw new PathError('access_level must be "read_only" or "read_write"');
  }
  return level;
}
