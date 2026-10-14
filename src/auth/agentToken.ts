import { AuthError, USER_ID_RE, b64urlEncode, decodeJwt, nowSeconds } from './jwt';

const ISSUER = 'lore-llm';
const AUDIENCE = 'lore-llm-mcp';
const textEncoder = new TextEncoder();

function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error('AGENT_TOKEN_SECRET must be at least 32 characters');
  return crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export interface AgentTokenClaims {
  agentId: string;
  userId: string;
}

/**
 * Agent tokens are HS256 JWTs. They only *identify* the agent and its parent
 * user; what the agent may do lives in D1, so revoking = deleting the row.
 */
export async function signAgentToken(secret: string, claims: AgentTokenClaims, expiresAt: number): Promise<string> {
  const header = b64urlEncode(textEncoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64urlEncode(
    textEncoder.encode(
      JSON.stringify({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: claims.agentId,
        uid: claims.userId,
        iat: nowSeconds(),
        exp: expiresAt,
      }),
    ),
  );
  const input = `${header}.${payload}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), textEncoder.encode(input));
  return `${input}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyAgentToken(secret: string, token: string): Promise<AgentTokenClaims> {
  const jwt = decodeJwt(token);
  if (jwt.header.alg !== 'HS256') throw new AuthError('Unsupported token algorithm');
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), jwt.signature, jwt.signingInput);
  if (!ok) throw new AuthError('Invalid token signature');
  const { iss, aud, sub, uid, exp } = jwt.payload;
  if (iss !== ISSUER || aud !== AUDIENCE) throw new AuthError('Invalid token');
  if (typeof exp !== 'number' || exp <= nowSeconds()) throw new AuthError('Token expired');
  if (typeof sub !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(sub)) throw new AuthError('Invalid token');
  if (typeof uid !== 'string' || !USER_ID_RE.test(uid)) throw new AuthError('Invalid token');
  return { agentId: sub, userId: uid };
}
