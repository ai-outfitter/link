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

export const READINESS_MODEL_VERSION = "readiness-model/v1alpha1" as const;
export type EvidenceState = "unknown" | "declared" | "detected" | "enforced" | "exercised" | "verified";
export type ReadinessDimension = "context" | "workflow" | "identity-and-authority" | "guardrails" | "auditability" | "improvement";
export type CapabilityId = "repository-context" | "accountable-ownership" | "shared-agent-context" | "named-workflow-responsibility" | "agent-identity" | "scoped-authority" | "automated-agent-workflow" | "automated-review" | "controlled-change-landing";
export interface CapabilityDefinition { id: CapabilityId; dimension: ReadinessDimension; requiredForRung: 1 | 2 | 3; requiredState: EvidenceState; title: string; description: string; nextAction: string }
export interface CapabilityAssessment { capability: CapabilityId; title: string; description: string; nextAction: string; dimension: ReadinessDimension; state: EvidenceState; requiredForRung: 1 | 2 | 3; requiredState: EvidenceState; evidence: EvidenceLocator[]; limitations: string[] }
export interface RepositoryReadinessAssessment { repository: RepositorySummary; revision: RepositoryObservation["revision"]; capabilities: CapabilityAssessment[]; coverage: CoverageRecord[]; rung: 0 | 1 | 2 | 3 }
export interface RungAssessment { rung: 0 | 1 | 2 | 3 | 4 | 5; name: string; status: "satisfied" | "not-satisfied" | "unavailable"; missingCapabilities: CapabilityId[] }
export interface DimensionAssessment { dimension: ReadinessDimension; state: EvidenceState; capabilities: CapabilityId[] }
export interface ReadinessAssessment {
  model: typeof READINESS_MODEL_VERSION; generatedAt: string; scope: GitHubScope; scopeLabel: "organization" | "installation";
  repositories: RepositoryReadinessAssessment[]; dimensions: DimensionAssessment[]; rungs: RungAssessment[];
  currentRung: 0 | 1 | 2 | 3; reviewedRung: null; coverage: CoverageRecord[]; limitations: string[];
}
export interface AssessmentOptions { generatedAt?: string }
