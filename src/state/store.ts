import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface PrState {
  passes: number;
  lastTriggerCommentId: number;
  /** Consecutive auto-review failures since the last successful pass. */
  failures: number;
}

interface StateData {
  prs: Record<string, PrState>;
}

export function prKey(fullName: string, prNumber: number): string {
  return `${fullName}#${prNumber}`;
}

/**
 * Validates and normalizes one raw JSON entry into a well-shaped `PrState`,
 * or returns null to drop it. Without this, a wrong-shape entry (e.g. a
 * string where `passes` should be a number) makes `recordPass` compute
 * `NaN`, so `hasBeenReviewed` stays false forever and the PR is re-reviewed
 * every cycle — the same unbounded-retry failure mode as the failure cap
 * below, through a different door. `failures` is optional on the raw input
 * (defaults to 0) so state files written before it existed still load.
 */
function normalizeEntry(value: unknown): PrState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const passes = v.passes;
  const lastTriggerCommentId = v.lastTriggerCommentId;
  const failures = v.failures ?? 0;
  if (typeof passes !== "number" || !Number.isFinite(passes)) return null;
  if (typeof lastTriggerCommentId !== "number" || !Number.isFinite(lastTriggerCommentId)) return null;
  if (typeof failures !== "number" || !Number.isFinite(failures)) return null;
  return { passes, lastTriggerCommentId, failures };
}

export class StateStore {
  private constructor(
    private readonly path: string,
    private data: StateData,
  ) {}

  static async open(path: string): Promise<StateStore> {
    let data: StateData = { prs: {} };
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StateData>;
      if (parsed && typeof parsed === "object" && parsed.prs && typeof parsed.prs === "object") {
        const prs: Record<string, PrState> = {};
        for (const [key, raw] of Object.entries(parsed.prs as Record<string, unknown>)) {
          const entry = normalizeEntry(raw);
          if (entry) prs[key] = entry;
        }
        data = { prs };
      }
    } catch {
      // Missing or corrupt state must never take the service down; start fresh.
      data = { prs: {} };
    }
    return new StateStore(path, data);
  }

  private entry(key: string): PrState {
    return this.data.prs[key] ?? { passes: 0, lastTriggerCommentId: 0, failures: 0 };
  }

  hasBeenReviewed(key: string): boolean {
    return this.entry(key).passes > 0;
  }

  passCount(key: string): number {
    return this.entry(key).passes;
  }

  async recordPass(key: string): Promise<number> {
    const next = { ...this.entry(key) };
    next.passes += 1;
    // A successful pass clears any run of consecutive failures.
    next.failures = 0;
    this.data.prs[key] = next;
    await this.flush();
    return next.passes;
  }

  failureCount(key: string): number {
    return this.entry(key).failures;
  }

  async recordFailure(key: string): Promise<number> {
    const next = { ...this.entry(key) };
    next.failures += 1;
    this.data.prs[key] = next;
    await this.flush();
    return next.failures;
  }

  lastTriggerCommentId(key: string): number {
    return this.entry(key).lastTriggerCommentId;
  }

  async setLastTriggerCommentId(key: string, id: number): Promise<void> {
    this.data.prs[key] = { ...this.entry(key), lastTriggerCommentId: id };
    await this.flush();
  }

  /** Write via a temp file + rename so a crash mid-write cannot corrupt state. */
  private async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmp, this.path);
  }
}
