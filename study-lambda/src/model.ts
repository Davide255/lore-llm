/**
 * The one place that talks to the Anthropic API. Everything else depends on
 * the `Model` interface, so tests drive the pipelines with a scripted fake.
 */
import Anthropic from '@anthropic-ai/sdk';

export type Block = Anthropic.Beta.BetaContentBlock;
export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type Tool = Anthropic.Beta.BetaTool;

export interface TurnRequest {
  system: string;
  messages: MessageParam[];
  tools: Tool[];
  maxTokens: number;
}

export interface Turn {
  content: Block[];
  stopReason: string | null;
}

export interface Model {
  /** One streamed request. `onBlock` fires as each content block completes. */
  turn(req: TurnRequest, onBlock: (block: Block) => void, signal?: AbortSignal): Promise<Turn>;
}

export function anthropicModel(opts: { apiKey: () => Promise<string>; model: string; effort?: 'low' | 'medium' | 'high' }): Model {
  let client: Anthropic | null = null;
  return {
    async turn(req, onBlock, signal) {
      client ??= new Anthropic({ apiKey: await opts.apiKey() });
      const stream = client.beta.messages.stream(
        {
          model: opts.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages,
          tools: req.tools,
          // Forced tool choice is rejected on the current models: the prompt names the tools.
          tool_choice: { type: 'auto' },
          output_config: { effort: opts.effort ?? 'medium' },
          // On a policy decline the API retries on the model's default fallback in the same call.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { signal },
      );
      stream.on('contentBlock', onBlock);
      const message = await stream.finalMessage();
      return { content: message.content, stopReason: message.stop_reason };
    },
  };
}
