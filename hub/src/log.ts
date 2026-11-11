/**
 * Minimal structured logger (JSON lines on stdout) with the same shape Fastify
 * expects, so one logger serves the HTTP server and the integrations.
 *
 * Secrets never belong in log lines; `redact()` is a safety net for URLs that
 * carry credentials (RTSP sources, device query strings).
 */

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 100 } as const;
type LevelName = keyof typeof LEVELS;

export interface Logger {
  level: string;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  fatal(obj: unknown, msg?: string): void;
  silent(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

const SECRET_PARAM = /([?&](?:password|pass|pwd|key|token|ticket|secret|code|access_token|refresh_token)=)[^&\s"']*/gi;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^\s/:@"']+):([^\s/@"']+)@/gi;

export function redact(text: string): string {
  return text.replace(URL_CREDENTIALS, '$1***:***@').replace(SECRET_PARAM, '$1***');
}

function serializeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { type: err.name, message: redact(err.message) };
  if (err.stack) out.stack = redact(err.stack);
  const code = (err as NodeJS.ErrnoException).code;
  if (code) out.code = code;
  if (err.cause instanceof Error) out.cause = serializeError(err.cause);
  return out;
}

const SENSITIVE_KEYS =
  /^(password|pass|pwd|token|secret|authorization|cookie|set-cookie|clientSecret|apiKey|masterKey|refreshToken|accessToken|totp|totpSecret)$/i;

function clean(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return serializeError(value);
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clean(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '***' : clean(v, depth + 1);
  }
  return out;
}

export function createLogger(level: string, bindings: Record<string, unknown> = {}, sink?: (line: string) => void): Logger {
  const threshold = LEVELS[(level as LevelName) in LEVELS ? (level as LevelName) : 'info'];
  const write = sink ?? ((line: string) => process.stdout.write(line + '\n'));

  const emit = (name: LevelName, obj: unknown, msg?: string) => {
    if (LEVELS[name] < threshold || name === 'silent') return;
    const record: Record<string, unknown> = { level: name, time: new Date().toISOString(), ...bindings };
    if (typeof obj === 'string') {
      record.msg = redact(obj);
    } else if (obj instanceof Error) {
      record.err = serializeError(obj);
      record.msg = msg ? redact(msg) : redact(obj.message);
    } else {
      Object.assign(record, clean(obj));
      if (msg) record.msg = redact(msg);
    }
    try {
      write(JSON.stringify(record));
    } catch {
      write(JSON.stringify({ level: name, time: record.time, msg: 'unserialisable log record' }));
    }
  };

  return {
    level,
    trace: (o, m) => emit('trace', o, m),
    debug: (o, m) => emit('debug', o, m),
    info: (o, m) => emit('info', o, m),
    warn: (o, m) => emit('warn', o, m),
    error: (o, m) => emit('error', o, m),
    fatal: (o, m) => emit('fatal', o, m),
    silent: () => {},
    child: (extra) => createLogger(level, { ...bindings, ...extra }, sink),
  };
}
