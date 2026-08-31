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
