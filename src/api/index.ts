import type { KnowledgeBaseClient } from './client';
import { MockKnowledgeBaseClient } from './mock/mock-client';

export * from './types';
export type { KnowledgeBaseClient, ServerEvent } from './client';

/**
 * The single client instance used by the app.
 *
 * When the backend exists, replace with:
 *   new HttpKnowledgeBaseClient(process.env.EXPO_PUBLIC_KB_API_URL!, getAccessToken)
 */
const mock = new MockKnowledgeBaseClient();
export const kb: KnowledgeBaseClient = mock;

/** Dev-only helper exposed in Settings while the mock is active. */
export const resetDemoData: (() => Promise<void>) | null = kb === mock ? () => mock.resetDemoData() : null;
