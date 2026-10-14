export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  COGNITO_REGION: string;
  COGNITO_USER_POOL_ID: string;
  /** Comma-separated Cognito app client ids. */
  COGNITO_CLIENT_IDS: string;
  /** HMAC secret used to sign agent tokens (wrangler secret). */
  AGENT_TOKEN_SECRET: string;
  /** Comma-separated allowed browser origins. */
  ALLOWED_ORIGINS?: string;
}

export type AccessLevel = 'read_only' | 'read_write';

/** The authenticated agent behind an MCP request. */
export interface AgentContext {
  agentId: string;
  userId: string;
  projectScope: string;
  accessLevel: AccessLevel;
}
