import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { type AppConfig, parseConfig } from "./schema.js";

export async function loadConfig(path: string): Promise<AppConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Config file not found or unreadable: ${path}`);
  }
  const config = parseConfig(parseYaml(text));
  const intervalOverride = process.env.POLL_INTERVAL_MINUTES;
  if (intervalOverride) {
    const parsed = Number.parseInt(intervalOverride, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(`POLL_INTERVAL_MINUTES must be a positive integer, got: ${intervalOverride}`);
    }
    config.pollIntervalMinutes = parsed;
  }
  if (process.env.TRIGGER_PHRASE) {
    config.triggerPhrase = process.env.TRIGGER_PHRASE;
  }
  return config;
}
