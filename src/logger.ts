export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  secrets?: string[];
}

/** Replace known secret values with `***`. Values shorter than 6 chars are ignored. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

export function defaultSecrets(): string[] {
  return [process.env.GITHUB_TOKEN, process.env.ANTHROPIC_API_KEY].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

/**
 * Extracts a human-readable message from an unknown caught value. A plain
 * `(error as Error).message` silently logs "undefined" whenever the
 * rejection wasn't an `Error` (a thrown string, a rejected non-Error value,
 * etc.), destroying the only diagnostic an unattended operator gets. This
 * is the one place that decision is made — every catch site should call it
 * instead of reaching for `.message` directly.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  const emit = (
    level: string,
    msg: string,
    meta: Record<string, unknown> | undefined,
    sink: (line: string) => void,
  ) => {
    const secrets = options.secrets ?? defaultSecrets();
    const suffix = meta ? ` ${redact(JSON.stringify(meta), secrets)}` : "";
    const line = `${new Date().toISOString()} [${level}] [${name}] ${redact(msg, secrets)}${suffix}`;
    sink(line);
  };
  return {
    // info stays on stdout; warn/error go to stderr — the NSSM `AppStderr`
    // file (see docs/windows-service.md) would otherwise always be empty,
    // reading as "no errors" even when the service is failing constantly.
    info: (msg, meta) => emit("INFO", msg, meta, (line) => console.log(line)),
    warn: (msg, meta) => emit("WARN", msg, meta, (line) => console.error(line)),
    error: (msg, meta) => emit("ERROR", msg, meta, (line) => console.error(line)),
  };
}
