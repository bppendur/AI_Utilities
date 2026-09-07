import { z } from "zod";

const repoEntrySchema = z.object({
  repo: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, "repo must be in the form owner/name"),
  role: z.string().min(1).optional(),
  filter: z.string().optional(),
});

const appConfigSchema = z.object({
  runtime: z.enum(["claude", "codex"]).default("claude"),
  pollIntervalMinutes: z.number().int().positive().default(10),
  triggerPhrase: z.string().min(1).default("@review-agent review"),
  defaults: z.object({
    role: z.string().min(1),
    filter: z.string().default(""),
  }),
  repos: z.array(repoEntrySchema).min(1, "at least one repo must be configured"),
});

export type RepoEntry = z.infer<typeof repoEntrySchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;

export interface ResolvedRepo {
  owner: string;
  name: string;
  fullName: string;
  role: string;
  filter: string;
}

export function parseConfig(raw: unknown): AppConfig {
  return appConfigSchema.parse(raw);
}

/** Per-repo `role`/`filter` fully replace the shared default when present. */
export function resolveRepos(config: AppConfig): ResolvedRepo[] {
  return config.repos.map((entry) => {
    const [owner, name] = entry.repo.split("/") as [string, string];
    return {
      owner,
      name,
      fullName: entry.repo,
      role: entry.role ?? config.defaults.role,
      filter: entry.filter ?? config.defaults.filter,
    };
  });
}
