const enc = new TextEncoder();

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

/**
 * Deletes a user from the Cognito pool (`AdminDeleteUser`), signing the request
 * with AWS Signature V4. `username` may be the user's `sub`.
 */
export async function adminDeleteUser(
  cfg: { region: string; userPoolId: string; accessKeyId: string; secretAccessKey: string },
  username: string,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<void> {
  const host = `cognito-idp.${cfg.region}.amazonaws.com`;
  const body = JSON.stringify({ UserPoolId: cfg.userPoolId, Username: username });
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const target = 'AWSCognitoIdentityProviderService.AdminDeleteUser';

  const signedHeaders = 'content-type;host;x-amz-date;x-amz-target';
  const canonical = [
    'POST',
    '/',
    '',
    `content-type:application/x-amz-json-1.1\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:${target}\n`,
    signedHeaders,
    await sha256(body),
  ].join('\n');
  const scope = `${day}/${cfg.region}/cognito-idp/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonical)].join('\n');

  let key: ArrayBuffer | Uint8Array = enc.encode(`AWS4${cfg.secretAccessKey}`);
  for (const part of [day, cfg.region, 'cognito-idp', 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));

  const res = await fetcher(`https://${host}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-date': amzDate,
      'x-amz-target': target,
      authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  });
  if (res.ok) return;
  // Already gone: deletion is idempotent.
  if ((await res.json().catch(() => ({})) as { __type?: string }).__type?.endsWith('UserNotFoundException')) return;
  throw new Error(`Cognito AdminDeleteUser failed (${res.status})`);
}
