import { MCP_EXTERNAL_CATEGORIES, MCPExternalError } from '@agor/core/mcp';
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
  extra?: Record<string, unknown>,
  logger: { error: (...args: unknown[]) => void } = console
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

  logger.error(label, {
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

const VALID_MCP_CATEGORIES = new Set<string>(MCP_EXTERNAL_CATEGORIES);

// NOTE: HTTP_*_PATTERN rules below are fallbacks for providers that embed HTTP status
// codes only in the error message string rather than in a structured `status` field.
// When a numeric `status` field is present, the explicit status checks within the unified
// rules match directly.
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
  rawMessage: string;
  msg: string;
  status?: number;
  exitCode?: number;
  signal?: string;
  errorClass?: string;
  code?: string;
  cause: unknown;
};

function normalizeStatus(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 100 && raw <= 599
    ? raw
    : typeof raw === 'string' && /^\d{3}$/.test(raw.trim())
      ? Number(raw.trim())
      : undefined;
}

function normalizeExitCode(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : undefined;
}

function extractRawErrorMessage(error: unknown, record: Record<string, unknown>): string {
  if (error instanceof Error) return error.message || '';
  if (typeof error === 'string') return error;
  if (typeof record.message === 'string') return record.message;
  return '';
}

function buildClassificationContext(error: unknown): ClassificationContext {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};

  const errorClass = typeof record.errorClass === 'string' ? record.errorClass : undefined;
  const signal = typeof record.signal === 'string' ? record.signal : undefined;
  const code = typeof record.code === 'string' ? record.code : undefined;

  const rawStatus = record.status ?? record.statusCode;
  const status = normalizeStatus(rawStatus);
  const rawMessage = extractRawErrorMessage(error, record);

  let exitCode = normalizeExitCode(record.exitCode);
  if (exitCode === undefined) {
    const match = rawMessage.match(EXIT_CODE_PATTERN);
    if (match?.[1]) exitCode = Number(match[1]);
  }

  return {
    rawMessage,
    msg: rawMessage.toLowerCase(),
    status,
    exitCode,
    signal,
    errorClass,
    code,
    cause: error,
  };
}

function isMCPDuckType(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  return (
    record.name === 'MCPExternalError' &&
    typeof record.category === 'string' &&
    VALID_MCP_CATEGORIES.has(record.category) &&
    record.diagnostic !== null &&
    typeof record.diagnostic === 'object' &&
    typeof (record.diagnostic as Record<string, unknown>).stage === 'string' &&
    typeof record.message === 'string'
  );
}

type UnifiedRule = {
  label: string;
  test: (ctx: ClassificationContext) => boolean;
  category: ClaudeExecutionErrorCategory;
  message: string | ((ctx: ClassificationContext) => string);
  isMissingCredential?: true;
};

const CLASSIFICATION_RULES: UnifiedRule[] = [
  // SDK startup failures
  {
    label: 'sdk:executable_not_found',
    test: (c) => c.errorClass === 'executable_not_found',
    category: 'process_failure',
    message: MESSAGES.executableNotFound,
  },
  {
    label: 'sdk:executable_launch_failed',
    test: (c) => c.errorClass === 'executable_launch_failed',
    category: 'process_failure',
    message: MESSAGES.executableLaunchFailed,
  },
  {
    label: 'sdk:spawn_failed',
    test: (c) => c.errorClass === 'spawn_failed' || c.errorClass === 'process_error',
    category: 'process_failure',
    message: MESSAGES.spawnFailed,
  },
  {
    label: 'sdk:initialize_timeout',
    test: (c) => c.errorClass === 'initialize_timeout',
    category: 'process_failure',
    message: MESSAGES.initializeTimeout,
  },
  // Process signals
  {
    label: 'sdk:process_killed_by_signal',
    test: (c) => c.errorClass === 'process_killed_by_signal' || Boolean(c.signal),
    category: 'process_failure',
    message: (c) => MESSAGES.processSignal(c.signal),
  },
  // Structured node network codes
  {
    label: 'network:error_code',
    test: (c) => Boolean(c.code && NETWORK_ERROR_CODES.has(c.code)),
    category: 'network',
    message: MESSAGES.network,
  },
  // HTTP 403 Forbidden
  {
    label: 'http:403',
    test: (c) =>
      c.status === 403 || c.msg.includes('403 forbidden') || HTTP_403_PATTERN.test(c.msg),
    category: 'authentication',
    message: MESSAGES.forbidden,
  },
  // HTTP 401 & invalid API keys (evaluated before missing_credential)
  {
    label: 'http:401_or_bad_key',
    test: (c) =>
      c.status === 401 ||
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
  // Missing credentials (unauthenticated session)
  {
    label: 'auth:missing_credential',
    test: (c) =>
      c.msg.includes('not logged in') ||
      c.msg.includes('please run /login') ||
      c.msg.includes('authentication is not configured'),
    category: 'missing_credential',
    message: MESSAGES.missingCredential,
    isMissingCredential: true,
  },
  // Billing & credit limits
  {
    label: 'billing:credit_exhausted',
    test: (c) =>
      c.msg.includes('credit balance') ||
      c.msg.includes('insufficient_quota') ||
      c.msg.includes('balance is exhausted') ||
      c.msg.includes('balance exhausted'),
    category: 'credit_exhausted',
    message: MESSAGES.creditExhausted,
  },
  // Rate limiting (HTTP 429 & message patterns)
  {
    label: 'http:429_or_rate_limit',
    test: (c) =>
      c.status === 429 ||
      c.msg.includes('rate limit') ||
      c.msg.includes('too many requests') ||
      HTTP_429_PATTERN.test(c.msg),
    category: 'rate_limit',
    message: MESSAGES.rateLimit,
  },
  // Temporary server unavailability (HTTP 500 & 502)
  {
    label: 'http:500_502_or_unavailable',
    test: (c) =>
      c.status === 500 ||
      c.status === 502 ||
      c.msg.includes('500 internal server error') ||
      c.msg.includes('502 bad gateway') ||
      HTTP_500_502_PATTERN.test(c.msg),
    category: 'overloaded',
    message: MESSAGES.unavailable,
  },
  // Upstream overload & gateway timeouts (HTTP 503, 504, 529)
  {
    label: 'http:503_504_529_or_overloaded',
    test: (c) =>
      c.status === 503 ||
      c.status === 504 ||
      c.status === 529 ||
      c.msg.includes('overloaded') ||
      c.msg.includes('service unavailable') ||
      c.msg.includes('gateway timeout') ||
      HTTP_503_504_529_PATTERN.test(c.msg),
    category: 'overloaded',
    message: MESSAGES.overloaded,
  },
  // Agentic execution limits
  {
    label: 'limit:turn',
    test: (c) => c.msg.includes('error_max_turns') || c.msg.includes('turn limit'),
    category: 'turn_limit',
    message: MESSAGES.turnLimit,
  },
  {
    label: 'limit:budget',
    test: (c) => c.msg.includes('error_max_budget_usd') || c.msg.includes('budget limit'),
    category: 'budget_limit',
    message: MESSAGES.budgetLimit,
  },
  {
    label: 'limit:structured_output',
    test: (c) => c.msg.includes('error_max_structured_output_retries'),
    category: 'structured_output_limit',
    message: MESSAGES.structuredOutputLimit,
  },
  // Network connection failures (string fallbacks)
  {
    label: 'network:string_fallback',
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
  // Unexpected process termination
  {
    label: 'process:nonzero_exit',
    test: (c) =>
      c.errorClass === 'process_exited_nonzero' ||
      (c.exitCode !== undefined && c.exitCode !== 0) ||
      NON_ZERO_EXIT_PATTERN.test(c.rawMessage),
    category: 'process_failure',
    message: (c) => MESSAGES.processExit(c.exitCode),
  },
];

/**
 * Classifies a raw Claude SDK error into a typed, user-safe error instance.
 *
 * The returned error's `.message` is always sanitized and safe for display.
 * The original error is retained as `.cause` for server-side diagnostics.
 *
 * @security Never serialize or forward `.cause.message` to clients.
 * It may contain raw provider payloads including API keys, auth tokens, or
 * filesystem paths from the original error.
 */
export function sanitizeClaudeExecutionError(
  error: unknown
): ClaudeExecutionError | ClaudeMissingCredentialError | MCPExternalError | AgorSetupError {
  // Pass-through guards for already typed instances
  if (error instanceof MCPExternalError) return error;
  if (isMCPDuckType(error)) return error as MCPExternalError;
  if (error instanceof ClaudeExecutionError || error instanceof ClaudeMissingCredentialError) {
    return error;
  }
  if (isAgorSetupError(error)) return error;

  if (error instanceof MissingCredentialError) {
    return new ClaudeMissingCredentialError(error.message || MESSAGES.missingCredential, {
      cause: error,
    });
  }

  const ctx = buildClassificationContext(error);
  const diag = {
    cause: error,
    exitCode: ctx.exitCode,
    signal: ctx.signal,
    errorClass: ctx.errorClass,
    code: ctx.code,
  };

  for (const rule of CLASSIFICATION_RULES) {
    if (rule.test(ctx)) {
      const text = typeof rule.message === 'function' ? rule.message(ctx) : rule.message;
      return rule.isMissingCredential
        ? new ClaudeMissingCredentialError(text, diag)
        : new ClaudeExecutionError(rule.category, text, diag);
    }
  }

  return new ClaudeExecutionError('unknown', MESSAGES.unknown, diag);
}
