export type Severity = "critical" | "major" | "minor" | "nit";

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  body: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
}

export interface RuntimeInput {
  /** Fully rendered prompt, including role and PR context. */
  prompt: string;
  /** Directory the PR head is checked out into; the runtime's cwd. */
  workspaceDir: string;
  timeoutMs: number;
}

export interface ReviewRuntime {
  readonly name: string;
  review(input: RuntimeInput): Promise<ReviewResult>;
}
