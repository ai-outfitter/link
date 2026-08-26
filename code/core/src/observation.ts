import type {
  ArtifactKind, CoverageRecord, GitHubRepository, GitHubRequestClient, GitHubScope,
  ObservationOptions, ObservedArtifact, RepositoryObservation, RepositorySummary, ScopeInventory,
} from "./schema.js";

type UnknownRecord = Record<string, unknown>;
interface RequestFailure { status: number | null; rateLimited: boolean }
interface TreeEntry { path: string; type: "blob" | "tree"; sha: string; size: number | null }

const DIRECTORY_LIMITS = new Map<string, number>([
  [".github", 2], [".agents", 3], ["agents", 3], ["catalog", 3],
  ["deploy", 3], ["deployments", 3], ["environments", 3], ["governance", 2], ["workflows", 2],
]);
const ROOT_MARKERS = new Map<string, ArtifactKind>([
  ["AGENTS.md", "agent-instructions"], ["CLAUDE.md", "agent-instructions"], ["CODEOWNERS", "code-owners"],
]);

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function compareText(left: string, right: string): number {
  const insensitive = left.toLowerCase().localeCompare(right.toLowerCase());
  return insensitive === 0 ? left.localeCompare(right) : insensitive;
}
function failureFrom(error: unknown): RequestFailure {
  const source = isRecord(error) ? error : {};
  const response = isRecord(source.response) ? source.response : {};
  const statusValue = source.status ?? response.status;
  const status = typeof statusValue === "number" ? statusValue : null;
  const headers = isRecord(source.headers) ? source.headers : isRecord(response.headers) ? response.headers : {};
  const remaining = headers["x-ratelimit-remaining"] ?? headers["X-RateLimit-Remaining"];
  return { status, rateLimited: status === 429 || (status === 403 && String(remaining) === "0") };
}
function failureReason(failure: RequestFailure): string {
  if (failure.rateLimited) return "rate_limited";
  if (failure.status === 403) return "permission_denied";
  if (failure.status === 404) return "not_found";
  return failure.status === null ? "request_failed" : `http_${failure.status}`;
}
function coverage(area: CoverageRecord["area"], status: CoverageRecord["status"], reason?: string): CoverageRecord {
  return reason === undefined ? { area, status } : { area, status, reason };
}

function normalizeRepository(value: UnknownRecord): RepositorySummary | null {
  const ownerValue = isRecord(value.owner) ? value.owner : {};
  const fullName = stringOrNull(value.full_name);
  const owner = stringOrNull(ownerValue.login) ?? fullName?.split("/")[0] ?? null;
  const name = stringOrNull(value.name) ?? fullName?.split("/")[1] ?? null;
  if (owner === null || name === null) return null;
  const rawVisibility = stringOrNull(value.visibility);
  const visibility = rawVisibility === "public" || rawVisibility === "private" || rawVisibility === "internal"
    ? rawVisibility
    : typeof value.private === "boolean" ? (value.private ? "private" : "public") : "unknown";
  return {
    owner, name, fullName: fullName ?? `${owner}/${name}`, nodeId: stringOrNull(value.node_id), visibility,
    defaultBranch: stringOrNull(value.default_branch),
    activityAt: stringOrNull(value.pushed_at) ?? stringOrNull(value.updated_at),
    archived: typeof value.archived === "boolean" ? value.archived : null,
    disabled: typeof value.disabled === "boolean" ? value.disabled : null,
  };
}

export async function listGitHubScope(client: GitHubRequestClient, scope: GitHubScope): Promise<ScopeInventory> {
  const repositories = new Map<string, RepositorySummary>();
  let page = 1;
  let scopeCoverage = coverage("scope", "complete");
  while (true) {
    let data: unknown;
    try {
      const route = scope.kind === "organization" ? "GET /orgs/{org}/repos" : "GET /installation/repositories";
      const parameters = scope.kind === "organization"
        ? { org: scope.owner, page, per_page: 100 }
        : { page, per_page: 100 };
      data = (await client.request(route, parameters)).data;
    } catch (error) {
      scopeCoverage = coverage("scope", "unknown", failureReason(failureFrom(error)));
      break;
    }
    const pageRepositories = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.repositories) ? data.repositories : null;
    if (pageRepositories === null) {
      scopeCoverage = coverage("scope", "unknown", "malformed_response");
      break;
    }
    let malformed = false;
    for (const candidate of pageRepositories) {
      const normalized = isRecord(candidate) ? normalizeRepository(candidate) : null;
      if (normalized === null) { malformed = true; continue; }
      repositories.set(normalized.fullName.toLowerCase(), normalized);
    }
    if (malformed) scopeCoverage = coverage("scope", "partial", "malformed_repository");
    const totalCount = isRecord(data) && typeof data.total_count === "number" ? data.total_count : null;
    if (pageRepositories.length < 100 || (totalCount !== null && page * 100 >= totalCount)) break;
    page += 1;
  }
  return {
    scope,
    repositories: [...repositories.values()].sort((a, b) => compareText(a.fullName, b.fullName)),
    coverage: [scopeCoverage],
  };
}

function parseTree(data: unknown): { entries: TreeEntry[]; truncated: boolean } | null {
  if (!isRecord(data) || !Array.isArray(data.tree)) return null;
  const entries: TreeEntry[] = [];
  for (const raw of data.tree) {
    if (!isRecord(raw)) return null;
    const path = stringOrNull(raw.path);
    const sha = stringOrNull(raw.sha);
    if (path === null || sha === null || (raw.type !== "blob" && raw.type !== "tree")) return null;
    entries.push({ path, sha, type: raw.type, size: typeof raw.size === "number" ? raw.size : null });
  }
  return { entries, truncated: data.truncated === true };
}
function artifactKind(path: string): ArtifactKind | null {
  const root = ROOT_MARKERS.get(path);
  if (root !== undefined) return root;
  if (path === ".github/CODEOWNERS") return "code-owners";
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)) return "workflow";
  if (/^\.github\/(?:dependabot|labeler)\.ya?ml$/i.test(path)) return "governance";
  if (/^\.agents\/.+\.(?:md|ya?ml|json|toml)$/i.test(path)) return "catalog";
  if (/^(?:agents|catalog)\/.+\.(?:md|ya?ml|json|toml)$/i.test(path)) return "catalog";
  if (/^workflows\/.+\.ya?ml$/i.test(path)) return "workflow";
  if (/^governance\/.+\.(?:md|ya?ml|json|toml)$/i.test(path)) return "governance";
  if (/^(?:deploy|deployments|environments)\/.+\.(?:md|ya?ml|json|toml|nix)$/i.test(path)) return "deployment";
  return null;
}
function mayDescend(path: string): boolean {
  return !path.startsWith(".github/") || path === ".github/workflows";
}
function unknownRepository(repository: GitHubRepository): RepositorySummary {
  return {
    owner: repository.owner, name: repository.name, fullName: `${repository.owner}/${repository.name}`,
    nodeId: null, visibility: "unknown", defaultBranch: null, activityAt: null, archived: null, disabled: null,
  };
}
function unavailableObservation(
  repository: GitHubRepository, options: ObservationOptions, area: "metadata" | "revision", reason: string,
  summary = unknownRepository(repository),
): RepositoryObservation {
  const requested = options.revision ?? summary.defaultBranch ?? "HEAD";
  return {
    repository: summary, revision: { requested, resolved: null }, artifacts: [], evidence: [],
    coverage: [
      coverage("metadata", area === "metadata" ? "unknown" : "complete", area === "metadata" ? reason : undefined),
      coverage("revision", "unknown", area === "revision" ? reason : "metadata_unavailable"),
      coverage("manifest", "unknown", "revision_unavailable"),
      coverage("content", "unknown", "manifest_unavailable"),
    ],
  };
}

export async function observeGitHubRepository(
  client: GitHubRequestClient, repository: GitHubRepository, options: ObservationOptions = {},
): Promise<RepositoryObservation> {
  const apiRepository = { owner: repository.owner, repo: repository.name };
  let metadataData: unknown;
  try { metadataData = (await client.request("GET /repos/{owner}/{repo}", apiRepository)).data; }
  catch (error) { return unavailableObservation(repository, options, "metadata", failureReason(failureFrom(error))); }
  const summary = isRecord(metadataData) ? normalizeRepository(metadataData) : null;
  if (summary === null) return unavailableObservation(repository, options, "metadata", "malformed_response");

  const requested = options.revision ?? summary.defaultBranch ?? "HEAD";
  let commitData: unknown;
  try {
    commitData = (await client.request("GET /repos/{owner}/{repo}/commits/{ref}", { ...apiRepository, ref: requested })).data;
  } catch (error) {
    return unavailableObservation(repository, options, "revision", failureReason(failureFrom(error)), summary);
  }
  const commit = isRecord(commitData) ? commitData : {};
  const commitDetail = isRecord(commit.commit) ? commit.commit : {};
  const treeDetail = isRecord(commitDetail.tree) ? commitDetail.tree : {};
  const resolved = stringOrNull(commit.sha);
  const rootTreeSha = stringOrNull(treeDetail.sha);
  if (resolved === null || rootTreeSha === null) {
    return unavailableObservation(repository, options, "revision", "malformed_response", summary);
  }

  const found: ObservedArtifact[] = [];
  const manifestReasons = new Set<string>();
  const queue: Array<{ prefix: string; sha: string; depth: number; maxDepth: number }> = [
    { prefix: "", sha: rootTreeSha, depth: 0, maxDepth: 0 },
  ];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let treeData: unknown;
    try {
      treeData = (await client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        ...apiRepository, tree_sha: current.sha,
      })).data;
    } catch (error) { manifestReasons.add(failureReason(failureFrom(error))); continue; }
    const tree = parseTree(treeData);
    if (tree === null) { manifestReasons.add("malformed_response"); continue; }
    if (tree.truncated) manifestReasons.add("tree_truncated");
    for (const entry of tree.entries) {
      const path = current.prefix === "" ? entry.path : `${current.prefix}/${entry.path}`;
      if (entry.type === "blob") {
        const kind = artifactKind(path);
        if (kind !== null) found.push({ path, kind, readable: null, size: entry.size, sha: entry.sha });
      } else if (current.prefix === "") {
        const maxDepth = DIRECTORY_LIMITS.get(entry.path);
        if (maxDepth !== undefined) queue.push({ prefix: entry.path, sha: entry.sha, depth: 1, maxDepth });
      } else if (current.depth < current.maxDepth && mayDescend(path)) {
        queue.push({ prefix: path, sha: entry.sha, depth: current.depth + 1, maxDepth: current.maxDepth });
      }
    }
  }

  found.sort((a, b) => compareText(a.path, b.path));
  const maxArtifacts = Math.max(1, Math.floor(options.maxArtifacts ?? 200));
  const artifacts = found.slice(0, maxArtifacts);
  if (found.length > maxArtifacts) manifestReasons.add("artifact_limit");
  const contentReasons = new Set<string>();
  for (const artifact of artifacts) {
    try {
      const data = (await client.request("GET /repos/{owner}/{repo}/contents/{path}", {
        ...apiRepository, path: artifact.path, ref: resolved,
      })).data;
      if (!isRecord(data) || data.type !== "file") contentReasons.add("malformed_response");
      else if (data.truncated === true || data.content === undefined) {
        contentReasons.add(data.truncated === true ? "content_truncated" : "content_unreadable");
      } else artifact.readable = true;
    } catch (error) { contentReasons.add(failureReason(failureFrom(error))); }
  }

  const reasonText = (reasons: Set<string>): string | undefined =>
    reasons.size === 0 ? undefined : [...reasons].sort(compareText).join(",");
  const manifestReason = reasonText(manifestReasons);
  const contentReason = reasonText(contentReasons);
  return {
    repository: summary, revision: { requested, resolved }, artifacts,
    evidence: artifacts.map((artifact) => ({
      artifact: artifact.kind, repository: summary.fullName, path: artifact.path, revision: resolved,
    })),
    coverage: [
      coverage("metadata", "complete"), coverage("revision", "complete"),
      coverage("manifest", manifestReason === undefined ? "complete" : "partial", manifestReason),
      coverage("content", contentReason === undefined ? "complete" : "unknown", contentReason),
    ],
  };
}
