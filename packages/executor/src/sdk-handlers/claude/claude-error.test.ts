import { asMCPExternalError } from '@agor/core/mcp';
import { describe, expect, it, vi } from 'vitest';
import { MissingCredentialError } from '../../handlers/sdk/base-executor.js';
import {
  AgorSetupError,
  ClaudeExecutionError,
  ClaudeMissingCredentialError,
  isClaudeAbortError,
  logClaudeFailure,
  MESSAGES,
  sanitizeClaudeExecutionError,
} from './claude-error.js';

describe('sanitizeClaudeExecutionError', () => {
  it('classifies invalid API key as authentication failure (not missing credential)', () => {
    const error = Object.assign(
      new Error('Claude Code returned an error result: Invalid API key · Fix external API key'),
      { errorClass: 'error_result' }
    );
    const sanitized = sanitizeClaudeExecutionError(error);
    expect(sanitized).toBeInstanceOf(ClaudeExecutionError);
    expect((sanitized as ClaudeExecutionError).category).toBe('authentication');
    expect(sanitized.message).toBe(MESSAGES.authentication);
  });

  it('classifies Bedrock and Vertex cloud IAM failures as authentication', () => {
    const error = new Error(
      'AccessDeniedException: User is not authorized to perform: bedrock:InvokeModel'
    );
    const sanitized = sanitizeClaudeExecutionError(error);
    expect((sanitized as ClaudeExecutionError).category).toBe('authentication');
    expect(sanitized.message).toBe(MESSAGES.authentication);
  });

  it('classifies unauthenticated CLI state as missing credential', () => {
    const error = Object.assign(
      new Error('Claude Code returned an error result: Not logged in · Please run /login'),
      { errorClass: 'error_result' }
    );
    const sanitized = sanitizeClaudeExecutionError(error);
    expect(sanitized).toBeInstanceOf(ClaudeMissingCredentialError);
    expect((sanitized as ClaudeMissingCredentialError).category).toBe('missing_credential');
    expect(sanitized.message).toBe(MESSAGES.missingCredential);
  });

  it('prioritizes authentication when process exit code is also present', () => {
    const error = Object.assign(
      new Error('Claude Code process exited with code 1: Invalid API key'),
      { exitCode: 1, errorClass: 'process_exited_nonzero' }
    );
    const sanitized = sanitizeClaudeExecutionError(error);
    expect((sanitized as ClaudeExecutionError).category).toBe('authentication');
    expect(sanitized.message).toBe(MESSAGES.authentication);
  });

  it('prioritizes missing credential when process exit code is also present', () => {
    const error = Object.assign(
      new Error('Claude Code process exited with code 1: Not logged in. Please run /login'),
      { exitCode: 1, errorClass: 'process_exited_nonzero' }
    );
    const sanitized = sanitizeClaudeExecutionError(error);
    expect(sanitized).toBeInstanceOf(ClaudeMissingCredentialError);
    expect((sanitized as ClaudeMissingCredentialError).category).toBe('missing_credential');
  });

  it('classifies unadorned non-zero exit code as process failure', () => {
    const error = Object.assign(new Error('Claude Code process exited with code 137'), {
      exitCode: 137,
      errorClass: 'process_exited_nonzero',
    });
    const sanitized = sanitizeClaudeExecutionError(error);
    expect((sanitized as ClaudeExecutionError).category).toBe('process_failure');
    expect(sanitized.message).toBe(MESSAGES.processExit(137));
  });

  it('classifies process termination by signal', () => {
    const error = Object.assign(new Error('Killed'), {
      signal: 'SIGKILL',
      errorClass: 'process_killed_by_signal',
    });
    const sanitized = sanitizeClaudeExecutionError(error);
    expect((sanitized as ClaudeExecutionError).category).toBe('process_failure');
    expect(sanitized.message).toBe(MESSAGES.processSignal('SIGKILL'));
  });

  it('passes through genuine MCPExternalError unchanged', () => {
    const mcpError = asMCPExternalError(new Error('tool failure'), {
      stage: 'runtime',
      category: 'provider_unavailable',
    });
    expect(sanitizeClaudeExecutionError(mcpError)).toBe(mcpError);
  });

  it('passes through valid duck-typed MCPExternalError', () => {
    const transported = {
      name: 'MCPExternalError',
      category: 'provider_rejected',
      diagnostic: { stage: 'oauth', message: 'oauth expired' },
      message: 'The MCP operation failed: provider_rejected',
    };
    expect(sanitizeClaudeExecutionError(transported)).toBe(transported);
  });

  it('classifies structured HTTP status codes from API client or provider', () => {
    const err401 = Object.assign(new Error('upstream call failed'), { status: 401 });
    const res401 = sanitizeClaudeExecutionError(err401);
    expect((res401 as ClaudeExecutionError).category).toBe('authentication');
    expect(res401.message).toBe(MESSAGES.authentication);

    const err403 = Object.assign(new Error('forbidden access'), { statusCode: '403' });
    const res403 = sanitizeClaudeExecutionError(err403);
    expect((res403 as ClaudeExecutionError).category).toBe('authentication');
    expect(res403.message).toBe(MESSAGES.forbidden);

    const err429 = Object.assign(new Error('rate limited'), { status: 429 });
    expect((sanitizeClaudeExecutionError(err429) as ClaudeExecutionError).category).toBe(
      'rate_limit'
    );

    const err503 = Object.assign(new Error('service down'), { status: 503 });
    expect((sanitizeClaudeExecutionError(err503) as ClaudeExecutionError).category).toBe(
      'overloaded'
    );
  });

  it('re-sanitizes malformed duck-typed MCP lookalikes safely', () => {
    const wrongType = {
      name: 'MCPExternalError',
      category: 123,
      message: 'malformed lookalike',
    };
    expect((sanitizeClaudeExecutionError(wrongType) as ClaudeExecutionError).category).toBe(
      'unknown'
    );

    const unknownCategory = {
      name: 'MCPExternalError',
      category: 'invalid_category_name',
      diagnostic: { stage: 'runtime' },
    };
    expect((sanitizeClaudeExecutionError(unknownCategory) as ClaudeExecutionError).category).toBe(
      'unknown'
    );

    const missingStage = {
      name: 'MCPExternalError',
      category: 'provider_rejected',
      diagnostic: { message: 'oauth expired' },
      message: 'The MCP operation failed: provider_rejected',
    };
    expect((sanitizeClaudeExecutionError(missingStage) as ClaudeExecutionError).category).toBe(
      'unknown'
    );
  });

  it('prevents URLs, tokens, and filesystem paths from leaking in user-facing message', () => {
    const rawError = new Error(
      'Request failed at https://api.anthropic.com/v1/messages with Bearer sk-ant-api03-SECRETTOKEN in /home/user/repo'
    );
    const sanitized = sanitizeClaudeExecutionError(rawError);
    expect(sanitized.message).toBe(MESSAGES.unknown);
    expect(sanitized.message).not.toContain('https://');
    expect(sanitized.message).not.toContain('sk-ant');
    expect(sanitized.message).not.toContain('/home/');
    expect(sanitized.cause).toBe(rawError);
  });

  it('cause is not enumerable in JSON serialization', () => {
    const raw = new Error('sk-ant-secret-token in the message');
    const sanitized = sanitizeClaudeExecutionError(raw);
    const json = JSON.stringify(sanitized);
    expect(json).not.toContain('sk-ant-secret-token');
  });

  it('passes through AgorSetupError and MissingCredentialError', () => {
    const setupError = new AgorSetupError('Working directory unavailable');
    expect(sanitizeClaudeExecutionError(setupError)).toBe(setupError);

    const credError = new MissingCredentialError('Custom missing credential');
    const sanitizedCred = sanitizeClaudeExecutionError(credError);
    expect(sanitizedCred).toBeInstanceOf(ClaudeMissingCredentialError);
    expect(sanitizedCred.message).toBe('Custom missing credential');
  });
});

describe('isClaudeAbortError', () => {
  it('detects SDK abort structurally from errorClass', () => {
    expect(isClaudeAbortError({ errorClass: 'aborted' })).toBe(true);
    expect(isClaudeAbortError(Object.assign(new Error('aborted'), { errorClass: 'aborted' }))).toBe(
      true
    );
    expect(isClaudeAbortError(new Error('ordinary error'))).toBe(false);
    expect(isClaudeAbortError({ errorClass: 'error_result' })).toBe(false);
    expect(isClaudeAbortError(null)).toBe(false);
  });
});

describe('logClaudeFailure', () => {
  it('logs category, message, and diagnostic fields', () => {
    const mockLogger = { error: vi.fn() };
    const err = new ClaudeExecutionError('process_failure', MESSAGES.processExit(137), {
      exitCode: 137,
      signal: 'SIGKILL',
    });
    logClaudeFailure('Failure label', err, { extra: true }, mockLogger);
    expect(mockLogger.error).toHaveBeenCalledWith('Failure label', {
      extra: true,
      category: 'process_failure',
      message: MESSAGES.processExit(137),
      exitCode: 137,
      signal: 'SIGKILL',
      errorClass: undefined,
      code: undefined,
    });

    const setupErr = new AgorSetupError('Working directory unavailable');
    logClaudeFailure('Setup failed', setupErr, undefined, mockLogger);
    expect(mockLogger.error).toHaveBeenCalledWith('Setup failed', {
      category: 'setup_error',
      message: 'Working directory unavailable',
      exitCode: undefined,
      signal: undefined,
      errorClass: undefined,
      code: undefined,
    });
  });
});

describe('sanitizeClaudeExecutionError — priority ordering', () => {
  it('P1 beats P13: executable_not_found errorClass wins over a non-zero exitCode in the same error', () => {
    const err = Object.assign(new Error('not found'), {
      errorClass: 'executable_not_found',
      exitCode: 127,
    });
    const result = sanitizeClaudeExecutionError(err) as ClaudeExecutionError;
    expect(result.category).toBe('process_failure');
    expect(result.message).toBe(MESSAGES.executableNotFound); // not processExit(127)
  });

  it('P4 (HTTP 403) beats P5 (HTTP 401) when both status and message disagree', () => {
    // Status field says 403, message says "401 unauthorized" — structured field wins
    const err = Object.assign(new Error('401 unauthorized from proxy'), { status: 403 });
    const result = sanitizeClaudeExecutionError(err) as ClaudeExecutionError;
    expect(result.category).toBe('authentication');
    expect(result.message).toBe(MESSAGES.forbidden); // 403 message, not 401
  });

  it('P5 (auth) beats P6 (missing_credential) when message contains both signals', () => {
    // Invalid API key message that also mentions "not logged in" — auth must win
    const err = new Error('invalid api key: not logged in');
    const result = sanitizeClaudeExecutionError(err) as ClaudeExecutionError;
    expect(result.category).toBe('authentication');
    expect(result.message).toBe(MESSAGES.authentication);
  });

  it('P8 (rate_limit) beats P13 (process_failure) when exit code and 429 both present', () => {
    const err = Object.assign(new Error('rate limit exceeded'), {
      exitCode: 1,
      errorClass: 'process_exited_nonzero',
    });
    const result = sanitizeClaudeExecutionError(err) as ClaudeExecutionError;
    expect(result.category).toBe('rate_limit');
  });

  it('P13 (process_failure) fires for a plain non-zero exit with no other signals', () => {
    const err = Object.assign(new Error('exited with code 137'), {
      exitCode: 137,
      errorClass: 'process_exited_nonzero',
    });
    const result = sanitizeClaudeExecutionError(err) as ClaudeExecutionError;
    expect(result.category).toBe('process_failure');
    expect(result.message).toBe(MESSAGES.processExit(137));
  });

  it('P14 (unknown) fires when no rule matches', () => {
    const err = new Error('completely unrecognised error format xyz');
    const result = sanitizeClaudeExecutionError(err) as ClaudeExecutionError;
    expect(result.category).toBe('unknown');
    expect(result.message).toBe(MESSAGES.unknown);
  });
});
