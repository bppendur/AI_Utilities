import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface PrState {
  passes: number;
  lastTriggerCommentId: number;
}

interface StateData {
  prs: Record<string, PrState>;
}

export function prKey(fullName: string, prNumber: number): string {
  return `${fullName}#${prNumber}`;
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
        data = { prs: parsed.prs };
      }
    } catch {
      // Missing or corrupt state must never take the service down; start fresh.
      data = { prs: {} };
    }
    return new StateStore(path, data);
  }

  private entry(key: string): PrState {
    return this.data.prs[key] ?? { passes: 0, lastTriggerCommentId: 0 };
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
    this.data.prs[key] = next;
    await this.flush();
    return next.passes;
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
