import { MCPExternalError } from '@agor/core/mcp';
import { MissingCredentialError } from '../../handlers/sdk/base-executor.js';

export type ClaudeExecutionErrorCategory =
  | 'authentication'
  | 'missing_credential'
  | 'credit_exhausted'
  | 'rate_limit'
  | 'overloaded'
  | 'turn_limit'
  | 'budget_limit'
  | 'structured_output_limit'
  | 'process_failure'
  | 'network'
  | 'unknown';

interface DiagnosticOptions {
  cause?: unknown;
  exitCode?: number;
  signal?: string;
  errorClass?: string;
  code?: string;
}

export class ClaudeExecutionError extends Error {
  readonly category: ClaudeExecutionErrorCategory;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly errorClass?: string;
  readonly code?: string;

  constructor(
    category: ClaudeExecutionErrorCategory,
    message: string,
    options?: DiagnosticOptions
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'ClaudeExecutionError';
    this.category = category;
    this.exitCode = options?.exitCode;
    this.signal = options?.signal;
    this.errorClass = options?.errorClass;
    this.code = options?.code;
  }
}

export class ClaudeMissingCredentialError extends MissingCredentialError {
  readonly category = 'missing_credential' as const;
  override readonly name = 'MissingCredentialError';
  readonly exitCode?: number;
  readonly signal?: string;
  readonly errorClass?: string;
  readonly code?: string;

  constructor(message: string, options?: DiagnosticOptions) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.exitCode = options?.exitCode;
    this.signal = options?.signal;
    this.errorClass = options?.errorClass;
    this.code = options?.code;
  }
}

export type ClaudeDiagnosticError = ClaudeExecutionError | ClaudeMissingCredentialError;

export function isClaudeDiagnosticError(error: unknown): error is ClaudeDiagnosticError {
  return error instanceof ClaudeExecutionError || error instanceof ClaudeMissingCredentialError;
}

export class AgorSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgorSetupError';
  }
}

export function isAgorSetupError(error: unknown): error is AgorSetupError {
  return error instanceof AgorSetupError;
}

export function isClaudeAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as { errorClass?: unknown }).errorClass === 'aborted'
  );
}

export function logClaudeFailure(
  label: string,
  safe: unknown,
  extra?: Record<string, unknown>
): void {
  const isClaude = isClaudeDiagnosticError(safe);
  const category =
    safe && typeof safe === 'object' && 'category' in safe
      ? (safe as { category: unknown }).category
      : isAgorSetupError(safe)
        ? 'setup_error'
        : undefined;

  const message =
    safe instanceof Error ? safe.message : typeof safe === 'string' ? safe : undefined;

  console.error(label, {
    ...extra,
    category,
    message,
    errorClass: isClaude ? safe.errorClass : undefined,
    exitCode: isClaude ? safe.exitCode : undefined,
    signal: isClaude ? safe.signal : undefined,
    code: isClaude ? safe.code : undefined,
  });
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

const VALID_MCP_CATEGORIES = new Set([
  'provider_unavailable',
  'provider_rejected',
  'invalid_response',
  'storage_policy_rejected',
  'configuration_required',
  'unknown',
]);

const HTTP_401_PATTERN = /\b(?:http(?: status)?|status(?: code)?|api error)\s*:?\s*401\b/;
const HTTP_403_PATTERN = /\b(?:http(?: status)?|status(?: code)?|api error)\s*:?\s*403\b/;
const HTTP_429_PATTERN = /\b(?:http(?: status)?|status(?: code)?|api error)\s*:?\s*429\b/;
const HTTP_500_502_PATTERN =
  /\b(?:http(?: status)?|status(?: code)?|api error)\s*:?\s*(?:500|502)\b/;
const HTTP_503_504_529_PATTERN =
  /\b(?:http(?: status)?|status(?: code)?|api error)\s*:?\s*(?:503|504|529)\b/;
const CLOUD_IAM_AUTH_PATTERN =
  /accessdenied|unrecognizedclient|expiredtoken|credentialsprovidererror|could not load credentials|authfailure/;
const EXIT_CODE_PATTERN = /exited with (?:non-zero )?code (\d{1,3})/i;
const NON_ZERO_EXIT_PATTERN = /\bprocess exited with (?:non-zero )?code (?!0\b)\d+/i;

export const MESSAGES = {
  authentication:
    'Claude Code authentication failed. Check your API key or provider credentials in Settings → Claude Code authentication.',
  forbidden:
    'Claude Code authentication failed (HTTP 403). Check your API key or provider credentials in Settings → Claude Code authentication, or that your account has access.',
  missingCredential:
    'Claude Code authentication is not configured. Please sign in or provide an API key.',
  creditExhausted:
    'Claude Code credit balance is too low. Please top up your Anthropic account credits.',
  rateLimit: 'Claude Code rate limit reached. Please wait before retrying your request.',
  overloaded:
    'Claude Code is currently overloaded or temporarily unavailable. Please retry shortly.',
  unavailable: 'Claude Code is temporarily unavailable. Please retry shortly.',
  turnLimit: 'Claude Code reached the maximum turn limit for this task.',
  budgetLimit: 'Claude Code reached the maximum budget limit for this task.',
  structuredOutputLimit: 'Claude Code reached the retry limit for structured output.',
  network: 'Claude Code could not reach the network service. Check your connection and retry.',
  initializeTimeout: 'Claude Code did not start in time. Retry your request.',
  executableNotFound:
    'Claude Code executable was not found. Please verify your Claude Code installation.',
  executableLaunchFailed:
    'Claude Code executable failed to launch. Verify system runtime compatibility and permissions.',
  spawnFailed: 'Failed to spawn Claude Code process. Verify your environment and permissions.',
  processSignal: (signal?: string) =>
    signal
      ? `Claude Code process was terminated by signal ${signal}.`
      : 'Claude Code process was terminated by a signal.',
  processExit: (exitCode?: number) =>
    exitCode
      ? `Claude Code process exited unexpectedly (code ${exitCode}). Retry your request, or check the logs if the issue persists.`
      : 'Claude Code process exited unexpectedly. Retry your request, or check the logs if the issue persists.',
  unknown:
    'Claude Code execution failed. Retry your request, or check the operational logs if the issue persists.',
} as const;

type ClassificationContext = {
  msg: string;
  rawMessage: string;
  status?: number;
  errorClass?: string;
  exitCode?: number;
  signal?: string;
  code?: string;
};

type Rule = {
  test: (ctx: ClassificationContext) => boolean;
  category: ClaudeExecutionErrorCategory;
  message: string | ((ctx: ClassificationContext) => string);
};

// Priority order: authentication rejections (401, 403, bad keys, IAM) MUST evaluate before
// missing credentials so expired or invalid keys never trigger misleading login recovery prompts.
const MESSAGE_RULES: Rule[] = [
  {
    test: (c) => c.msg.includes('403 forbidden') || HTTP_403_PATTERN.test(c.msg),
    category: 'authentication',
    message: MESSAGES.forbidden,
  },
  {
    test: (c) =>
      c.msg.includes('invalid api key') ||
      c.msg.includes('invalid_api_key') ||
      c.msg.includes('api key not valid') ||
      c.msg.includes('fix external api key') ||
      c.msg.includes('401 unauthorized') ||
      HTTP_401_PATTERN.test(c.msg) ||
      CLOUD_IAM_AUTH_PATTERN.test(c.msg),
    category: 'authentication',
    message: MESSAGES.authentication,
  },
  {
    test: (c) =>
      c.msg.includes('not logged in') ||
      c.msg.includes('please run /login') ||
      c.msg.includes('authentication is not configured'),
    category: 'missing_credential',
    message: MESSAGES.missingCredential,
  },
  {
    test: (c) =>
      c.msg.includes('credit balance') ||
      c.msg.includes('insufficient_quota') ||
      c.msg.includes('balance is exhausted') ||
      c.msg.includes('balance exhausted'),
    category: 'credit_exhausted',
    message: MESSAGES.creditExhausted,
  },
  {
    test: (c) =>
      c.msg.includes('rate limit') ||
      c.msg.includes('too many requests') ||
      HTTP_429_PATTERN.test(c.msg),
    category: 'rate_limit',
    message: MESSAGES.rateLimit,
  },
  {
    test: (c) =>
      c.msg.includes('500 internal server error') ||
      c.msg.includes('502 bad gateway') ||
      HTTP_500_502_PATTERN.test(c.msg),
    category: 'overloaded',
    message: MESSAGES.unavailable,
  },
  {
    test: (c) =>
      c.msg.includes('overloaded') ||
      c.msg.includes('service unavailable') ||
      c.msg.includes('gateway timeout') ||
      HTTP_503_504_529_PATTERN.test(c.msg),
    category: 'overloaded',
    message: MESSAGES.overloaded,
  },
  {
    test: (c) => c.msg.includes('error_max_turns') || c.msg.includes('turn limit'),
    category: 'turn_limit',
    message: MESSAGES.turnLimit,
  },
  {
    test: (c) => c.msg.includes('error_max_budget_usd') || c.msg.includes('budget limit'),
    category: 'budget_limit',
    message: MESSAGES.budgetLimit,
  },
  {
    test: (c) => c.msg.includes('error_max_structured_output_retries'),
    category: 'structured_output_limit',
    message: MESSAGES.structuredOutputLimit,
  },
  {
    test: (c) =>
      c.msg.includes('fetch failed') ||
      c.msg.includes('network error') ||
      c.msg.includes('connection refused') ||
      c.msg.includes('connection reset') ||
      c.msg.includes('socket hang up') ||
      c.msg.includes('timed out') ||
      c.msg.includes('timeout'),
    category: 'network',
    message: MESSAGES.network,
  },
  {
    test: (c) =>
      c.errorClass === 'process_exited_nonzero' ||
      (c.exitCode !== undefined && c.exitCode !== 0) ||
      NON_ZERO_EXIT_PATTERN.test(c.rawMessage),
    category: 'process_failure',
    message: (c) => MESSAGES.processExit(c.exitCode),
  },
];

export function sanitizeClaudeExecutionError(
  error: unknown
): ClaudeExecutionError | ClaudeMissingCredentialError | MCPExternalError | AgorSetupError {
  if (error instanceof MCPExternalError) return error;

  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  if (
    record.name === 'MCPExternalError' &&
    typeof record.category === 'string' &&
    VALID_MCP_CATEGORIES.has(record.category) &&
    record.diagnostic &&
    typeof record.diagnostic === 'object'
  ) {
    return error as MCPExternalError;
  }

  if (error instanceof ClaudeExecutionError || error instanceof ClaudeMissingCredentialError) {
    return error;
  }
  if (isAgorSetupError(error)) return error;

  const errorClass = typeof record.errorClass === 'string' ? record.errorClass : undefined;
  const signal = typeof record.signal === 'string' ? record.signal : undefined;
  const code = typeof record.code === 'string' ? record.code : undefined;

  const rawStatus = record.status ?? record.statusCode;
  const status =
    typeof rawStatus === 'number' &&
    Number.isInteger(rawStatus) &&
    rawStatus >= 100 &&
    rawStatus <= 599
      ? rawStatus
      : typeof rawStatus === 'string' && /^\d{3}$/.test(rawStatus.trim())
        ? Number(rawStatus.trim())
        : undefined;

  let exitCode =
    typeof record.exitCode === 'number' && Number.isInteger(record.exitCode)
      ? record.exitCode
      : typeof record.exitCode === 'string' && /^\d{1,3}$/.test(record.exitCode.trim())
        ? Number(record.exitCode.trim())
        : undefined;

  const rawMessage =
    error instanceof Error
      ? error.message || ''
      : typeof error === 'string'
        ? error
        : typeof record.message === 'string'
          ? record.message
          : '';

  if (exitCode === undefined) {
    const match = rawMessage.match(EXIT_CODE_PATTERN);
    if (match?.[1]) exitCode = Number(match[1]);
  }

  const diag = { cause: error, exitCode, signal, errorClass, code };

  if (error instanceof MissingCredentialError) {
    return new ClaudeMissingCredentialError(error.message || MESSAGES.missingCredential, diag);
  }

  // Explicit SDK startup errorClass values take precedence over message inspection
  if (errorClass === 'executable_not_found') {
    return new ClaudeExecutionError('process_failure', MESSAGES.executableNotFound, diag);
  }
  if (errorClass === 'executable_launch_failed') {
    return new ClaudeExecutionError('process_failure', MESSAGES.executableLaunchFailed, diag);
  }
  if (errorClass === 'spawn_failed' || errorClass === 'process_error') {
    return new ClaudeExecutionError('process_failure', MESSAGES.spawnFailed, diag);
  }
  if (errorClass === 'initialize_timeout') {
    return new ClaudeExecutionError('process_failure', MESSAGES.initializeTimeout, diag);
  }
  if (errorClass === 'process_killed_by_signal' || signal) {
    return new ClaudeExecutionError('process_failure', MESSAGES.processSignal(signal), diag);
  }

  if (code && NETWORK_ERROR_CODES.has(code)) {
    return new ClaudeExecutionError('network', MESSAGES.network, diag);
  }

  const msg = rawMessage.toLowerCase();

  // Authoritative numeric status codes from API client/provider
  if (status === 403) {
    return new ClaudeExecutionError('authentication', MESSAGES.forbidden, diag);
  }
  if (status === 401) {
    return new ClaudeExecutionError('authentication', MESSAGES.authentication, diag);
  }
  if (status === 429) {
    const isCredit = msg.includes('credit balance') || msg.includes('insufficient_quota');
    return new ClaudeExecutionError(
      isCredit ? 'credit_exhausted' : 'rate_limit',
      isCredit ? MESSAGES.creditExhausted : MESSAGES.rateLimit,
      diag
    );
  }
  if (status === 500 || status === 502) {
    return new ClaudeExecutionError('overloaded', MESSAGES.unavailable, diag);
  }
  if (status === 503 || status === 504 || status === 529) {
    return new ClaudeExecutionError('overloaded', MESSAGES.overloaded, diag);
  }

  const ctx: ClassificationContext = {
    msg,
    rawMessage,
    status,
    errorClass,
    exitCode,
    signal,
    code,
  };

  for (const rule of MESSAGE_RULES) {
    if (rule.test(ctx)) {
      const text = typeof rule.message === 'function' ? rule.message(ctx) : rule.message;
      return rule.category === 'missing_credential'
        ? new ClaudeMissingCredentialError(text, diag)
        : new ClaudeExecutionError(rule.category, text, diag);
    }
  }

  return new ClaudeExecutionError('unknown', MESSAGES.unknown, diag);
}
