import { Octokit } from "@octokit/rest";

export const MAX_DIFF_CHARS = 200_000;

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PullRequestDetails {
  number: number;
  title: string;
  body: string;
  author: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  draft: boolean;
  changedFiles: string[];
  diff: string;
}

export interface TriggerComment {
  id: number;
  author: string;
  createdAt: string;
  body: string;
}

export interface PriorReview {
  author: string;
  submittedAt: string;
  body: string;
}

export class GitHubClient {
  constructor(readonly octokit: Octokit) {}

  static fromToken(token: string): GitHubClient {
    if (!token) throw new Error("GITHUB_TOKEN is required but was empty");
    return new GitHubClient(new Octokit({ auth: token }));
  }

  async searchPullRequestNumbers(query: string): Promise<number[]> {
    const res = await this.octokit.rest.search.issuesAndPullRequests({
      q: query,
      per_page: 100,
    });
    return res.data.items.map((item) => item.number);
  }

  async getPullRequest(ref: PullRequestRef): Promise<PullRequestDetails> {
    const params = { owner: ref.owner, repo: ref.repo, pull_number: ref.number };
    const [detail, files, diff] = await Promise.all([
      this.octokit.rest.pulls.get(params),
      this.octokit.rest.pulls.listFiles({ ...params, per_page: 100 }),
      this.octokit.rest.pulls.get({ ...params, mediaType: { format: "diff" } }),
    ]);
    const raw = diff.data as unknown as string;
    return {
      number: detail.data.number,
      title: detail.data.title,
      body: detail.data.body ?? "",
      author: detail.data.user?.login ?? "unknown",
      headRef: detail.data.head.ref,
      headSha: detail.data.head.sha,
      baseRef: detail.data.base.ref,
      draft: detail.data.draft ?? false,
      changedFiles: files.data.map((f) => f.filename),
      diff:
        raw.length > MAX_DIFF_CHARS
          ? `${raw.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated] — inspect the checked-out working tree for the rest`
          : raw,
    };
  }

  async listTriggerComments(
    ref: PullRequestRef,
    triggerPhrase: string,
  ): Promise<TriggerComment[]> {
    const res = await this.octokit.rest.issues.listComments({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
      per_page: 100,
    });
    const needle = triggerPhrase.toLowerCase();
    return res.data
      .filter((c) => (c.body ?? "").toLowerCase().includes(needle))
      .map((c) => ({
        id: c.id,
        author: c.user?.login ?? "unknown",
        createdAt: c.created_at,
        body: c.body ?? "",
      }));
  }

  async listPriorReviews(ref: PullRequestRef): Promise<PriorReview[]> {
    const res = await this.octokit.rest.pulls.listReviews({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      per_page: 100,
    });
    return res.data
      .filter((r) => (r.body ?? "").trim().length > 0)
      .map((r) => ({
        author: r.user?.login ?? "unknown",
        submittedAt: r.submitted_at ?? "",
        body: r.body ?? "",
      }));
  }
}
