/**
 * Lambda entry point: Function URL with InvokeMode RESPONSE_STREAM (template.yaml).
 * `awslambda` is a global of the Node.js managed runtime.
 */
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { Writable } from 'node:stream';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { handle, type AppDeps } from './app';
import { anthropicModel } from './model';
import { workerClient } from './worker-client';

declare const awslambda: {
  streamifyResponse(
    fn: (event: APIGatewayProxyEventV2, responseStream: Writable, context: unknown) => Promise<void>,
  ): unknown;
  HttpResponseStream: {
    from(stream: Writable, metadata: { statusCode: number; headers: Record<string, string> }): Writable;
  };
};

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

const verifier = CognitoJwtVerifier.create({
  userPoolId: env('COGNITO_USER_POOL_ID'),
  // ID or access tokens, like the Worker: the app sends its ID token.
  tokenUse: null,
  clientId: env('COGNITO_CLIENT_IDS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
});

/**
 * The Anthropic key lives in an SSM SecureString (CloudFormation can't resolve
 * `ssm-secure` into Lambda environment variables), read once per container.
 * ANTHROPIC_API_KEY wins when set, for local runs.
 */
let apiKey: Promise<string> | null = null;
function anthropicKey(): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) return Promise.resolve(process.env.ANTHROPIC_API_KEY);
  apiKey ??= new SSMClient({})
    .send(new GetParameterCommand({ Name: env('ANTHROPIC_API_KEY_PARAM'), WithDecryption: true }))
    .then((r) => {
      if (!r.Parameter?.Value) throw new Error('Empty Anthropic key parameter');
      return r.Parameter.Value;
    })
    .catch((err) => {
      apiKey = null; // retry on the next request
      throw err;
    });
  return apiKey;
}

const deps: AppDeps = {
  verify: async (token) => ({ userId: (await verifier.verify(token)).sub }),
  model: anthropicModel({ apiKey: anthropicKey, model: process.env.STUDY_MODEL || 'claude-sonnet-5-5' }),
  kb: (token) => workerClient(env('LORE_API_URL'), token),
  // The report's date when the app doesn't send one: the users are in Italy.
  today: () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date()),
  log: (msg, extra) => console.error(msg, JSON.stringify(extra)),
};

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  await handle(
    { method: event.requestContext.http.method, path: event.rawPath, headers: event.headers ?? {}, body },
    {
      open(status, headers) {
        const out = awslambda.HttpResponseStream.from(responseStream, { statusCode: status, headers });
        return { write: (chunk) => out.write(chunk), end: () => out.end() };
      },
    },
    deps,
  );
});
