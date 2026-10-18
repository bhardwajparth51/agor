import { describe, expect, it, vi } from 'vitest';
import {
  classifyProviderFallback,
  claudeResultFailureCode,
  projectClaudeResultResponse,
  projectContextUsageSnapshot,
  projectNormalizedSdkResponse,
} from './sdk-result-safety';

describe('projectClaudeResultResponse', () => {
  it('returns a runtime-validated closed projection without provider prose or extensions', () => {
    const sentinel = 'SENTINEL_CLAUDE_RESULT_BODY_71e4';
    const projected = projectClaudeResultResponse({
      type: 'result',
      subtype: 'success',
      result: `provider result ${sentinel}`,
      errors: [`provider error ${sentinel}`],
      duration_ms: 12,
      duration_api_ms: Number.POSITIVE_INFINITY,
      is_error: false,
      num_turns: 0,
      total_cost_usd: 0.25,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: Number.NaN,
        provider_secret: sentinel,
      },
      modelUsage: { [sentinel]: { inputTokens: 10 } },
      permission_denials: [{ message: sentinel }],
      provider_extension: { secret: sentinel },
    });

    expect(projected).toEqual({
      type: 'result',
      subtype: 'success',
      duration_ms: 12,
      is_error: false,
      num_turns: 0,
      total_cost_usd: 0.25,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
      },
    });
    expect(JSON.stringify(projected)).not.toContain(sentinel);
  });

  it('does not invoke hostile field getters', () => {
    const getter = vi.fn(() => {
      throw new Error('SENTINEL_GETTER');
    });
    const value = { type: 'result' };
    Object.defineProperties(value, {
      subtype: { get: getter },
      result: { get: getter },
      usage: { get: getter },
      modelUsage: { get: getter },
    });

    expect(projectClaudeResultResponse(value)).toEqual({ type: 'result', subtype: 'unknown' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects values which are not SDK result records', () => {
    expect(projectClaudeResultResponse(undefined)).toBeUndefined();
    expect(
      projectClaudeResultResponse({ type: 'turn.completed', result: 'secret' })
    ).toBeUndefined();
  });
});

describe('normalized SDK response projection', () => {
  it('rebuilds every nested object and excludes extensions', () => {
    const sentinel = 'SENTINEL_NORMALIZED_EXTENSION_25d8';
    const projected = projectNormalizedSdkResponse({
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cacheReadTokens: 3,
        provider_secret: sentinel,
      },
      contextWindowLimit: 200_000,
      costUsd: 0.2,
      primaryModel: 'claude-sonnet-4-6',
      durationMs: 12,
      contextUsageSnapshot: {
        totalTokens: 123,
        maxTokens: 200_000,
        percentage: 1,
        memoryFiles: [{ path: sentinel }],
      },
      providerExtension: { secret: sentinel },
    });

    expect(projected).toEqual({
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cacheReadTokens: 3,
      },
      contextWindowLimit: 200_000,
      costUsd: 0.2,
      primaryModel: 'claude-sonnet-4-6',
      durationMs: 12,
      contextUsageSnapshot: { totalTokens: 123, maxTokens: 200_000, percentage: 1 },
    });
    expect(JSON.stringify(projected)).not.toContain(sentinel);
  });

  it('does not invoke prototype or own accessors', () => {
    const getter = vi.fn(() => {
      throw new Error('SENTINEL_NORMALIZED_GETTER');
    });
    const inherited = Object.create({ provider_secret: 'SENTINEL_PROTOTYPE' });
    Object.defineProperty(inherited, 'tokenUsage', { get: getter });
    expect(projectNormalizedSdkResponse(inherited)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  it('projects only the canonical context snapshot scalars', () => {
    const sentinel = 'SENTINEL_CONTEXT_MEMORY_PATH';
    expect(
      projectContextUsageSnapshot({
        totalTokens: 20,
        maxTokens: 100,
        percentage: 20,
        rawMaxTokens: 110,
        model: 'provider-model',
        memoryFiles: [{ path: sentinel, type: sentinel, tokens: 2 }],
        categories: [{ name: sentinel, tokens: 2, color: '#fff' }],
      })
    ).toEqual({ totalTokens: 20, maxTokens: 100, percentage: 20 });
  });

  it('rejects non-finite and incomplete normalized values', () => {
    expect(
      projectNormalizedSdkResponse({
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: Number.NaN },
      })
    ).toBeUndefined();
    expect(
      projectContextUsageSnapshot({ totalTokens: 1, maxTokens: Infinity, percentage: 1 })
    ).toBeUndefined();
  });
});

describe('claudeResultFailureCode', () => {
  it('keeps only the closed failure code, never provider prose', () => {
    expect(
      claudeResultFailureCode({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        errors: ['SENTINEL_PROSE'],
        result: 'SENTINEL_RESULT',
      })
    ).toBe('error_max_turns');
    expect(claudeResultFailureCode({ type: 'result', subtype: 'success', is_error: true })).toBe(
      'is_error'
    );
    expect(claudeResultFailureCode({ type: 'result', subtype: 'success' })).toBeUndefined();
    expect(claudeResultFailureCode({ type: 'result', subtype: 'SENTINEL' })).toBeUndefined();
  });
});

describe('classifyProviderFallback', () => {
  it('classifies zero_turn when a success result produced no assistant response', () => {
    expect(
      classifyProviderFallback({
        status: 'failed',
        error_message:
          'Agor could not confirm a successful response. Review any output and tool activity before retrying.',
        raw_sdk_response: { type: 'result', subtype: 'success', is_error: false },
      })
    ).toBe('zero_turn');

    // Also supports legacy text
    expect(
      classifyProviderFallback({
        status: 'failed',
        error_message:
          'The provider ended the request without returning a model response. Retry the prompt.',
        raw_sdk_response: { type: 'result', subtype: 'success', is_error: false },
      })
    ).toBe('zero_turn');
  });

  it('classifies provider_error when result reports an error subtype', () => {
    expect(
      classifyProviderFallback({
        status: 'failed',
        error_message:
          'Agor could not confirm a successful response. Review any output and tool activity before retrying. Provider detail: error_during_execution',
        raw_sdk_response: { type: 'result', subtype: 'error_during_execution', is_error: true },
      })
    ).toBe('provider_error');
  });

  it('classifies provider_error from structured raw response even when provider detail code is unavailable in error_message', () => {
    expect(
      classifyProviderFallback({
        status: 'failed',
        error_message:
          'Agor could not confirm a successful response. Review any output and tool activity before retrying.',
        raw_sdk_response: { type: 'result', subtype: 'error_during_execution', is_error: true },
      })
    ).toBe('provider_error');
  });

  it('classifies provider_error when result has subtype success but is_error true', () => {
    expect(
      classifyProviderFallback({
        status: 'failed',
        error_message:
          'Agor could not confirm a successful response. Review any output and tool activity before retrying. Provider detail: is_error',
        raw_sdk_response: { type: 'result', subtype: 'success', is_error: true },
      })
    ).toBe('provider_error');
  });

  it('classifies provider_error when provider detail is appended even if raw response is absent', () => {
    expect(
      classifyProviderFallback({
        status: 'failed',
        error_message:
          'Agor could not confirm a successful response. Review any output and tool activity before retrying. Provider detail: error_max_turns',
      })
    ).toBe('provider_error');
  });

  it('classifies missing_result when stream ends without a terminal result', () => {
    expect(
      classifyProviderFallback({
        status: 'failed',
        error_message:
          'The Claude Code stream closed without a final result. Completion could not be confirmed. Review any output and tool activity before retrying.',
      })
    ).toBe('missing_result');
  });

  it('returns undefined for non-failed tasks', () => {
    expect(
      classifyProviderFallback({
        status: 'completed',
        error_message: null,
      })
    ).toBeUndefined();
    expect(
      classifyProviderFallback({
        status: 'running',
        error_message: null,
      })
    ).toBeUndefined();
  });

  it('returns undefined for unrelated failures', () => {
    expect(
      classifyProviderFallback({
        status: 'failed',
        error_message:
          'Your team has reached its limit of work running at once. Wait for something to finish, then try again.',
      })
    ).toBeUndefined();
    expect(
      classifyProviderFallback({
        status: 'failed',
        error_message: 'Permission request timed out after 30000ms.',
      })
    ).toBeUndefined();
    expect(
      classifyProviderFallback({
        status: 'failed',
        error_message: 'The agent went over its 6 GiB memory limit and was stopped.',
      })
    ).toBeUndefined();
  });
});
