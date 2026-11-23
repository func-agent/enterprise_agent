/**
 * 结构化 JSON 日志。日志中强制脱敏 Authorization Header（见 4.4 Key 治理第 4 条）。
 */
import { config } from './config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'apikey',
  'api_key',
  'password',
  'secret',
  'token',
  'accesskey',
  'access_key',
  'secretkey',
  'secret_key',
  'cookie',
  'set-cookie',
]);

export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = '***REDACTED***';
      } else {
        out[k] = redactValue(v);
      }
    }
    return out;
  }
  return value;
}

function emit(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta ? (redactValue(meta) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(record);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit('debug', scope, m, meta),
    info: (m, meta) => emit('info', scope, m, meta),
    warn: (m, meta) => emit('warn', scope, m, meta),
    error: (m, meta) => emit('error', scope, m, meta),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

/**
 * 出网检查：仅允许白名单域名出网（见 8.3 出网安全第 1 条）。
 * 出网代理是唯一出口，网关在发起请求前先做 SNI 级白名单校验。
 */
export function isEgressAllowed(hostname: string): boolean {
  return config.gateway.egressAllowedHosts.some(
    (allowed) => hostname === allowed || hostname.endsWith('.' + allowed),
  );
}
