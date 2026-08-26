export type CoverageStatus = "complete" | "partial" | "unknown";

export interface CoverageRecord {
  area: "scope" | "metadata" | "revision" | "manifest" | "content";
  status: CoverageStatus;
  reason?: string;
}

export interface RepositoryIdentity {
  owner: string;
  name: string;
  fullName: string;
  nodeId: string | null;
}

export interface RepositorySummary extends RepositoryIdentity {
  visibility: "public" | "private" | "internal" | "unknown";
  defaultBranch: string | null;
  activityAt: string | null;
  archived: boolean | null;
  disabled: boolean | null;
}

export interface ScopeInventory {
  scope: GitHubScope;
  repositories: RepositorySummary[];
  coverage: CoverageRecord[];
}

export type GitHubScope =
  | { kind: "installation" }
  | { kind: "organization"; owner: string };

export interface GitHubRepository {
  owner: string;
  name: string;
}

export interface ObservationOptions {
  revision?: string;
  maxArtifacts?: number;
}

export type ArtifactKind =
  | "agent-instructions"
  | "catalog"
  | "code-owners"
  | "deployment"
  | "governance"
  | "workflow";

export interface ObservedArtifact {
  path: string;
  kind: ArtifactKind;
  readable: boolean | null;
  size: number | null;
  sha: string | null;
}

export interface EvidenceLocator {
  artifact: ArtifactKind;
  repository: string;
  path: string;
  revision: string;
}

export interface RepositoryObservation {
  repository: RepositorySummary;
  revision: {
    requested: string;
    resolved: string | null;
  };
  artifacts: ObservedArtifact[];
  evidence: EvidenceLocator[];
  coverage: CoverageRecord[];
}

export interface GitHubResponse<T = unknown> {
  data: T;
  status?: number;
  headers?: Record<string, string | number | undefined>;
}

export interface GitHubRequestClient {
  request<T = unknown>(route: string, parameters?: Record<string, unknown>): Promise<GitHubResponse<T>>;
}
