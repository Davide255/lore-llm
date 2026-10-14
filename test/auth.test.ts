import { beforeEach, describe, expect, it } from 'vitest';
import { signAgentToken, verifyAgentToken } from '../src/auth/agentToken';
import { _resetJwksCache, verifyCognitoToken } from '../src/auth/cognito';
import { AuthError, b64urlEncode, nowSeconds } from '../src/auth/jwt';

const SECRET = 's'.repeat(40);
const enc = new TextEncoder();

describe('agent tokens', () => {
  it('round-trips', async () => {
    const t = await signAgentToken(SECRET, { agentId: 'a1', userId: 'u1' }, nowSeconds() + 60);
    expect(await verifyAgentToken(SECRET, t)).toEqual({ agentId: 'a1', userId: 'u1' });
  });
  it('rejects expiry, tampering and a wrong secret', async () => {
    const expired = await signAgentToken(SECRET, { agentId: 'a1', userId: 'u1' }, nowSeconds() - 1);
    await expect(verifyAgentToken(SECRET, expired)).rejects.toThrow('expired');
    const ok = await signAgentToken(SECRET, { agentId: 'a1', userId: 'u1' }, nowSeconds() + 60);
    const [h, , s] = ok.split('.');
    const forged = `${h}.${b64urlEncode(enc.encode(JSON.stringify({ iss: 'lore-llm', aud: 'lore-llm-mcp', sub: 'a1', uid: 'victim', exp: nowSeconds() + 60 })))}.${s}`;
    await expect(verifyAgentToken(SECRET, forged)).rejects.toBeInstanceOf(AuthError);
    await expect(verifyAgentToken('z'.repeat(40), ok)).rejects.toBeInstanceOf(AuthError);
  });
  it('rejects alg=none', async () => {
    const h = b64urlEncode(enc.encode('{"alg":"none"}'));
    const p = b64urlEncode(enc.encode('{}'));
    await expect(verifyAgentToken(SECRET, `${h}.${p}.x`)).rejects.toBeInstanceOf(AuthError);
  });
});

describe('cognito tokens', () => {
  const cfg = { region: 'eu-north-1', userPoolId: 'eu-north-1_TEST', clientIds: ['client-1'] };
  const iss = `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`;
  let pair: CryptoKeyPair;
  let fetcher: (u: string) => Promise<Response>;
  let fetches = 0;

  async function mint(claims: Record<string, unknown>, key = pair.privateKey, kid = 'k1') {
    const h = b64urlEncode(enc.encode(JSON.stringify({ alg: 'RS256', kid })));
    const p = b64urlEncode(enc.encode(JSON.stringify(claims)));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${h}.${p}`));
    return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`;
  }
  const good = () => ({ iss, sub: 'user-1', token_use: 'id', aud: 'client-1', exp: nowSeconds() + 60 });

  beforeEach(async () => {
    _resetJwksCache();
    fetches = 0;
    pair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
    fetcher = async () => (fetches++, new Response(JSON.stringify({ keys: [jwk] })));
  });

  it('accepts a valid ID token and caches the JWKS', async () => {
    expect(await verifyCognitoToken(await mint(good()), cfg, fetcher)).toEqual({ userId: 'user-1' });
    await verifyCognitoToken(await mint(good()), cfg, fetcher);
    expect(fetches).toBe(1);
  });
  it('accepts an access token via client_id', async () => {
    const t = await mint({ ...good(), token_use: 'access', aud: undefined, client_id: 'client-1' });
    expect((await verifyCognitoToken(t, cfg, fetcher)).userId).toBe('user-1');
  });
  it.each([
    ['wrong issuer', { iss: 'https://evil' }],
    ['expired', { exp: nowSeconds() - 5 }],
    ['wrong audience', { aud: 'other' }],
    ['unknown token_use', { token_use: 'refresh' }],
    ['unsafe sub', { sub: '../x' }],
  ])('rejects %s', async (_n, patch) => {
    await expect(verifyCognitoToken(await mint({ ...good(), ...patch }), cfg, fetcher)).rejects.toBeInstanceOf(AuthError);
  });
  it('rejects a token signed by another key', async () => {
    const other = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    await expect(verifyCognitoToken(await mint(good(), other.privateKey), cfg, fetcher)).rejects.toBeInstanceOf(AuthError);
  });
});
