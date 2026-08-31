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

function defaultSecrets(): string[] {
  return [process.env.GITHUB_TOKEN, process.env.ANTHROPIC_API_KEY].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  const emit = (level: string, msg: string, meta?: Record<string, unknown>) => {
    const secrets = options.secrets ?? defaultSecrets();
    const suffix = meta ? ` ${redact(JSON.stringify(meta), secrets)}` : "";
    const line = `${new Date().toISOString()} [${level}] [${name}] ${redact(msg, secrets)}${suffix}`;
    console.log(line);
  };
  return {
    info: (msg, meta) => emit("INFO", msg, meta),
    warn: (msg, meta) => emit("WARN", msg, meta),
    error: (msg, meta) => emit("ERROR", msg, meta),
  };
}
