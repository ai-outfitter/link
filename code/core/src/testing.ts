import type { GitHubRequestClient, GitHubResponse } from "./schema.js";

type FixtureValue = unknown | { error: { status: number; rateLimited?: boolean } };

export interface ObservationFixture {
  scopePages: unknown[][];
  metadata: unknown;
  commit: unknown;
  trees: Record<string, FixtureValue>;
  contents: Record<string, FixtureValue>;
}

export interface FixtureRequest {
  route: string;
  parameters: Record<string, unknown>;
}

const repository = (index: number) => ({
  name: index === 42 ? "widget" : `repo-${String(index).padStart(3, "0")}`,
  full_name: index === 42 ? "acme/widget" : `acme/repo-${String(index).padStart(3, "0")}`,
  node_id: `REPO_${index}`,
  owner: { login: "acme" },
  visibility: index % 3 === 0 ? "private" : "public",
  default_branch: "main",
  pushed_at: `2026-08-${String((index % 25) + 1).padStart(2, "0")}T12:00:00Z`,
  archived: index === 3,
  disabled: index === 4,
});

const scopeRepositories = Array.from({ length: 105 }, (_, index) => repository(index));

export const observationFixture: ObservationFixture = {
  scopePages: [scopeRepositories.slice(0, 100), [...scopeRepositories.slice(100), scopeRepositories[0]]],
  metadata: {
    name: "widget", full_name: "acme/widget", node_id: "REPO_42", owner: { login: "acme" },
    visibility: "private", default_branch: "main", pushed_at: "2026-08-26T12:00:00Z",
    archived: false, disabled: false,
  },
  commit: { sha: "0123456789abcdef0123456789abcdef01234567", commit: { tree: { sha: "tree-root" } } },
  trees: {
    "tree-root": { tree: [
      { path: "src", type: "tree", sha: "tree-src" },
      { path: "governance", type: "tree", sha: "tree-governance" },
      { path: "AGENTS.md", type: "blob", sha: "blob-agents", size: 40 },
      { path: ".github", type: "tree", sha: "tree-github" },
      { path: "environments", type: "tree", sha: "tree-environments" },
      { path: ".agents", type: "tree", sha: "tree-dotagents" },
      { path: "agents", type: "tree", sha: "tree-agents" },
      { path: "README.md", type: "blob", sha: "blob-readme", size: 20 },
    ], truncated: false },
    "tree-github": { tree: [
      { path: "workflows", type: "tree", sha: "tree-github-workflows" },
      { path: "CODEOWNERS", type: "blob", sha: "blob-codeowners", size: 14 },
      { path: "ISSUE_TEMPLATE", type: "tree", sha: "tree-issues" },
    ], truncated: false },
    "tree-github-workflows": { tree: [
      { path: "custom-review.yml", type: "blob", sha: "blob-review", size: 120 },
      { path: "notes.txt", type: "blob", sha: "blob-notes", size: 3 },
    ], truncated: false },
    "tree-dotagents": { tree: [
      { path: "settings.yml", type: "blob", sha: "blob-settings", size: 80 },
      { path: "cache.bin", type: "blob", sha: "blob-cache", size: 9 },
    ], truncated: false },
    "tree-agents": { tree: [{ path: "reviewer", type: "tree", sha: "tree-reviewer" }], truncated: false },
    "tree-reviewer": { tree: [{ path: "agent.md", type: "blob", sha: "blob-agent", size: 55 }], truncated: false },
    "tree-governance": { tree: [{ path: "policy.yml", type: "blob", sha: "blob-policy", size: 91 }], truncated: false },
    "tree-environments": { tree: [{ path: "production", type: "tree", sha: "tree-production" }], truncated: true },
    "tree-production": { tree: [{ path: "deployment.yml", type: "blob", sha: "blob-deployment", size: 77 }], truncated: false },
  },
  contents: {
    "AGENTS.md": { type: "file", encoding: "base64", content: "YWdlbnRz" },
    ".github/CODEOWNERS": { type: "file", encoding: "base64", content: "KiBAdGVhbQ==" },
    ".github/workflows/custom-review.yml": { type: "file", encoding: "base64", content: "bmFtZTogcmV2aWV3" },
    ".agents/settings.yml": { type: "file", encoding: "base64", content: "c291cmNlczogW10=" },
    "agents/reviewer/agent.md": { type: "file", encoding: "base64", content: "IyBSZXZpZXdlcg==" },
    "governance/policy.yml": { error: { status: 403 } },
    "environments/production/deployment.yml": { type: "file", encoding: "base64", content: "bmFtZTogcHJvZA==" },
  },
};

function fixtureError(value: FixtureValue): value is { error: { status: number; rateLimited?: boolean } } {
  return value !== null && typeof value === "object" && "error" in value;
}

export class ObservationFixtureClient implements GitHubRequestClient {
  readonly calls: FixtureRequest[] = [];
  constructor(readonly fixture: ObservationFixture = observationFixture) {}

  async request<T = unknown>(route: string, parameters: Record<string, unknown> = {}): Promise<GitHubResponse<T>> {
    this.calls.push({ route, parameters: { ...parameters } });
    let value: FixtureValue;
    if (route === "GET /orgs/{org}/repos" || route === "GET /installation/repositories") {
      const page = typeof parameters.page === "number" ? parameters.page : 1;
      const repositories = this.fixture.scopePages[page - 1] ?? [];
      value = route === "GET /installation/repositories"
        ? { total_count: this.fixture.scopePages.flat().length - 1, repositories }
        : repositories;
    } else if (route === "GET /repos/{owner}/{repo}") value = this.fixture.metadata;
    else if (route === "GET /repos/{owner}/{repo}/commits/{ref}") value = this.fixture.commit;
    else if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
      value = this.fixture.trees[String(parameters.tree_sha)] ?? { error: { status: 404 } };
    } else if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
      value = this.fixture.contents[String(parameters.path)] ?? { error: { status: 404 } };
    } else value = { error: { status: 404 } };

    if (fixtureError(value)) {
      throw {
        status: value.error.status,
        headers: value.error.rateLimited ? { "x-ratelimit-remaining": "0" } : {},
      };
    }
    return { data: value as T, status: 200, headers: {} };
  }
}

export function createObservationFixtureClient(fixture: ObservationFixture = observationFixture): ObservationFixtureClient {
  return new ObservationFixtureClient(fixture);
}
