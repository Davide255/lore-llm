export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  COGNITO_REGION: string;
  COGNITO_USER_POOL_ID: string;
  /** Comma-separated Cognito app client ids. */
  COGNITO_CLIENT_IDS: string;
  /** HMAC secret used to sign agent tokens (wrangler secret). */
  AGENT_TOKEN_SECRET: string;
  /** Cognito hosted UI domain (host only). With OAUTH_COGNITO_CLIENT_ID it enables OAuth on /mcp. */
  COGNITO_DOMAIN?: string;
  /** Cognito app client (public, PKCE) whose callback is `<worker>/oauth/callback`. */
  OAUTH_COGNITO_CLIENT_ID?: string;
  /**
   * Optional IAM credentials allowed `cognito-idp:AdminDeleteUser` on the user pool (wrangler secrets).
   * Without them, account deletion still wipes all data but leaves the Cognito identity in place.
   */
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
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
