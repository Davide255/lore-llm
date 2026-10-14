const textEncoder = new TextEncoder();

export class AuthError extends Error {
  constructor(
    message: string,
    public status = 401,
  ) {
    super(message);
  }
}

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const bin = atob(input.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: Uint8Array;
  signature: Uint8Array;
}

export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p === '')) throw new AuthError('Malformed token');
  const [h, p, s] = parts as [string, string, string];
  try {
    const dec = new TextDecoder();
    const header = JSON.parse(dec.decode(b64urlDecode(h)));
    const payload = JSON.parse(dec.decode(b64urlDecode(p)));
    if (typeof header !== 'object' || header === null || typeof payload !== 'object' || payload === null) {
      throw new Error('not objects');
    }
    return { header, payload, signingInput: textEncoder.encode(`${h}.${p}`), signature: b64urlDecode(s) };
  } catch {
    throw new AuthError('Malformed token');
  }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** user ids come from Cognito `sub` (UUID); reject anything that could alter an R2 key. */
export const USER_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
