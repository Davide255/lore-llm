import { AuthError, USER_ID_RE, b64urlDecode, decodeJwt, nowSeconds } from './jwt';

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientIds: string[];
}

type Fetcher = (url: string) => Promise<Response>;

interface JwksCache {
  url: string;
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
/** Minimum gap between refetches triggered by an unknown `kid` (avoids a fetch-amplification DoS). */
const JWKS_MIN_REFETCH_MS = 60 * 1000;

let cache: JwksCache | null = null;

export function _resetJwksCache(): void {
  cache = null;
}

async function loadJwks(url: string, fetcher: Fetcher): Promise<JwksCache> {
  const res = await fetcher(url);
  if (!res.ok) throw new AuthError('Unable to load identity provider keys', 503);
  const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']),
    );
  }
  return { url, keys, fetchedAt: Date.now() };
}

async function getKey(url: string, kid: string, fetcher: Fetcher): Promise<CryptoKey | undefined> {
  const fresh = cache && cache.url === url && Date.now() - cache.fetchedAt < JWKS_TTL_MS;
  if (!fresh) cache = await loadJwks(url, fetcher);
  let key = cache!.keys.get(kid);
  if (!key && Date.now() - cache!.fetchedAt > JWKS_MIN_REFETCH_MS) {
    cache = await loadJwks(url, fetcher); // key rotation
    key = cache.keys.get(kid);
  }
  return key;
}

/** Verifies a Cognito ID or access token and returns the user id (`sub`) and, for ID tokens, email and name. */
export async function verifyCognitoToken(
  token: string,
  cfg: CognitoConfig,
  fetcher: Fetcher = (u) => fetch(u),
): Promise<{ userId: string; email?: string; name?: string }> {
  const jwt = decodeJwt(token);
  if (jwt.header.alg !== 'RS256' || typeof jwt.header.kid !== 'string') throw new AuthError('Invalid token');

  const issuer = `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`;
  const key = await getKey(`${issuer}/.well-known/jwks.json`, jwt.header.kid, fetcher);
  if (!key) throw new AuthError('Unknown signing key');
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, jwt.signature, jwt.signingInput);
  if (!ok) throw new AuthError('Invalid token signature');

  const p = jwt.payload;
  if (p.iss !== issuer) throw new AuthError('Invalid token issuer');
  if (typeof p.exp !== 'number' || p.exp <= nowSeconds()) throw new AuthError('Token expired');
  // ID tokens carry the client in `aud`; access tokens in `client_id`.
  const client = p.token_use === 'id' ? p.aud : p.token_use === 'access' ? p.client_id : undefined;
  if (typeof client !== 'string' || !cfg.clientIds.includes(client)) throw new AuthError('Invalid token audience');
  if (typeof p.sub !== 'string' || !USER_ID_RE.test(p.sub)) throw new AuthError('Invalid token subject');
  // Only ID tokens carry the profile; access tokens leave these undefined.
  return {
    userId: p.sub,
    ...(typeof p.email === 'string' ? { email: p.email } : {}),
    ...(typeof p.name === 'string' ? { name: p.name } : {}),
  };
}

export function cognitoConfigFromEnv(env: {
  COGNITO_REGION: string;
  COGNITO_USER_POOL_ID: string;
  COGNITO_CLIENT_IDS: string;
}): CognitoConfig {
  return {
    region: env.COGNITO_REGION,
    userPoolId: env.COGNITO_USER_POOL_ID,
    clientIds: env.COGNITO_CLIENT_IDS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

// exported for tests
export { b64urlDecode };
