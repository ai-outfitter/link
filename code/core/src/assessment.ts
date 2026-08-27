import type { AssessmentOptions, CapabilityAssessment, CapabilityDefinition, CapabilityId, CoverageRecord, DimensionAssessment, EvidenceLocator, EvidenceState, GitHubScope, ReadinessAssessment, ReadinessDimension, RepositoryObservation, RepositoryReadinessAssessment, RungAssessment } from "./schema.js";
import { READINESS_MODEL_VERSION } from "./schema.js";

const STATE_RANK: Record<EvidenceState, number> = { unknown: 0, declared: 1, detected: 2, enforced: 3, exercised: 4, verified: 5 };
export const capabilityDefinitions: readonly CapabilityDefinition[] = [
  { id: "repository-context", dimension: "context", requiredForRung: 1, requiredState: "detected", title: "Repository context", description: "Agents can find repository-specific instructions for working safely in this codebase.", nextAction: "Add a readable AGENTS.md or CLAUDE.md file at the repository root." },
  { id: "accountable-ownership", dimension: "guardrails", requiredForRung: 1, requiredState: "detected", title: "Accountable ownership", description: "The repository identifies the people or teams accountable for reviewing changes.", nextAction: "Add a readable CODEOWNERS file at the repository root or under .github/." },
  { id: "shared-agent-context", dimension: "context", requiredForRung: 2, requiredState: "detected", title: "Shared agent context", description: "Agent configuration is committed where collaborators and automation can use the same context.", nextAction: "Commit shared agent configuration under .agents/ or agents/." },
  { id: "named-workflow-responsibility", dimension: "workflow", requiredForRung: 2, requiredState: "detected", title: "Named workflow responsibility", description: "A committed workflow names an automated responsibility that agents can perform consistently.", nextAction: "Add a named YAML workflow under .github/workflows/ that defines an agent responsibility." },
  { id: "agent-identity", dimension: "identity-and-authority", requiredForRung: 2, requiredState: "detected", title: "Agent identity", description: "At least one committed agent profile gives an automated actor a stable identity and role.", nextAction: "Define a named agent profile under .agents/agents/ or agents/." },
  { id: "scoped-authority", dimension: "identity-and-authority", requiredForRung: 2, requiredState: "detected", title: "Scoped authority", description: "Committed settings state what agents may do instead of leaving their authority implicit.", nextAction: "Declare agent permissions or authority in a readable .agents/settings.yml, JSON, or TOML file." },
  { id: "automated-agent-workflow", dimension: "workflow", requiredForRung: 3, requiredState: "exercised", title: "Exercised agent workflow", description: "An agent workflow has run successfully, proving that the declared automation works in practice.", nextAction: "Run the agent workflow successfully and retain evidence of a successful run from the last 90 days." },
  { id: "automated-review", dimension: "improvement", requiredForRung: 3, requiredState: "exercised", title: "Exercised automated review", description: "Automated review has run successfully on a real change, not merely been declared in configuration.", nextAction: "Run an automated review workflow successfully on a real change and retain evidence from the last 90 days." },
  { id: "controlled-change-landing", dimension: "auditability", requiredForRung: 3, requiredState: "enforced", title: "Controlled change landing", description: "Default-branch controls enforce independent review before changes land.", nextAction: "Require pull requests, CODEOWNERS review, and an independent required approval or check on the default branch." },
];
const dimensions: readonly ReadinessDimension[] = ["context", "workflow", "identity-and-authority", "guardrails", "auditability", "improvement"];
function compareText(a: string, b: string): number { const folded = a.toLowerCase().localeCompare(b.toLowerCase()); return folded === 0 ? a.localeCompare(b) : folded }
function locators(observation: RepositoryObservation, predicate: (locator: EvidenceLocator) => boolean): EvidenceLocator[] { return observation.evidence.filter(predicate).sort((a, b) => compareText(a.path, b.path)) }
function evidenceFor(observation: RepositoryObservation, id: CapabilityId): EvidenceLocator[] {
  switch (id) {
    case "repository-context": return locators(observation, (item) => item.artifact === "agent-instructions");
    case "accountable-ownership": return locators(observation, (item) => item.artifact === "code-owners");
    case "shared-agent-context": return locators(observation, (item) => item.artifact === "catalog");
    case "named-workflow-responsibility": return locators(observation, (item) => item.artifact === "workflow");
    case "agent-identity": return locators(observation, (item) => item.artifact === "catalog" && /(?:^|\/)agents?\//i.test(item.path));
    case "scoped-authority": return locators(observation, (item) => item.artifact === "catalog" && /settings\.(?:ya?ml|json|toml)$/i.test(item.path));
    case "automated-agent-workflow": return locators(observation, (item) => item.artifact === "workflow");
    case "automated-review": return locators(observation, (item) => item.artifact === "workflow" && /review/i.test(item.path));
    case "controlled-change-landing": return locators(observation, (item) => item.artifact === "code-owners" || item.artifact === "governance");
  }
}
function capability(observation: RepositoryObservation, definition: CapabilityDefinition): CapabilityAssessment {
  const candidates = evidenceFor(observation, definition.id);
  const readable = new Set(observation.artifacts.filter((item) => item.readable === true).map((item) => item.path));
  const evidence = candidates.filter((item) => readable.has(item.path));
  const state: EvidenceState = evidence.length > 0 ? "detected" : candidates.length > 0 ? "declared" : "unknown";
  const limitations: string[] = [];
  if (definition.requiredForRung === 3 && state !== "unknown") limitations.push(definition.id === "controlled-change-landing" ? "Mutable branch and review enforcement was not collected by the shallow observation." : "No successful exercise within the 90-day evidence window was collected.");
  if (observation.coverage.some((record) => record.status !== "complete")) limitations.push("Repository coverage is incomplete; absence is not negative evidence.");
  return { capability: definition.id, title: definition.title, description: definition.description, nextAction: definition.nextAction, dimension: definition.dimension, state, requiredForRung: definition.requiredForRung, requiredState: definition.requiredState, evidence, limitations };
}
function meets(value: EvidenceState, required: EvidenceState): boolean { return STATE_RANK[value] >= STATE_RANK[required] }
export function assessGitHubRepository(observation: RepositoryObservation): RepositoryReadinessAssessment {
  const capabilities = capabilityDefinitions.map((definition) => capability(observation, definition));
  let rung: 0 | 1 | 2 | 3 = 0;
  for (const candidate of [1, 2, 3] as const) { if (capabilities.filter((item) => item.requiredForRung <= candidate).every((item) => meets(item.state, item.requiredState))) rung = candidate; else break }
  return { repository: observation.repository, revision: observation.revision, capabilities, coverage: observation.coverage, rung };
}
function rungAssessments(repositories: RepositoryReadinessAssessment[]): RungAssessment[] {
  const names = ["Observed", "Assisted", "Delegated", "Automated with guardrails", "Measured", "Adaptive"];
  return names.map((name, rung) => {
    if (rung >= 4) return { rung: rung as 4 | 5, name, status: "unavailable", missingCapabilities: [] };
    const missing = capabilityDefinitions.filter((definition) => definition.requiredForRung <= rung && repositories.some((repository) => { const item = repository.capabilities.find((candidate) => candidate.capability === definition.id); return item === undefined || !meets(item.state, definition.requiredState) })).map((item) => item.id);
    return { rung: rung as 0 | 1 | 2 | 3, name, status: missing.length === 0 ? "satisfied" : "not-satisfied", missingCapabilities: missing };
  });
}
function dimensionAssessments(repositories: RepositoryReadinessAssessment[]): DimensionAssessment[] {
  return dimensions.map((dimension) => { const values = repositories.flatMap((repository) => repository.capabilities.filter((item) => item.dimension === dimension)); const rank = values.length === 0 ? 0 : Math.min(...values.map((item) => STATE_RANK[item.state])); const state = (Object.entries(STATE_RANK).find(([, value]) => value === rank)?.[0] ?? "unknown") as EvidenceState; return { dimension, state, capabilities: capabilityDefinitions.filter((item) => item.dimension === dimension).map((item) => item.id) } });
}
export function assessGitHubScope(scope: GitHubScope, inventoryCoverage: CoverageRecord[], observations: RepositoryObservation[], options: AssessmentOptions = {}): ReadinessAssessment {
  const repositories = observations.map(assessGitHubRepository).sort((a, b) => compareText(a.repository.fullName, b.repository.fullName));
  const rungs = rungAssessments(repositories); const currentRung = ([3, 2, 1, 0] as const).find((rung) => rungs[rung].status === "satisfied") ?? 0;
  const limitations = new Set<string>();
  if (scope.kind === "installation") limitations.add("This is an installation-scope assessment, not a complete organization claim.");
  if (inventoryCoverage.some((item) => item.status !== "complete")) limitations.add("Repository inventory coverage is incomplete.");
  if (repositories.length === 0) limitations.add("No repositories were available to assess.");
  if (repositories.some((item) => item.coverage.some((record) => record.status !== "complete"))) limitations.add("One or more repository observations have partial or unknown coverage.");
  limitations.add("Rungs 4 and 5 are visible roadmap states and cannot be awarded by readiness-model/v1alpha1.");
  return { model: READINESS_MODEL_VERSION, generatedAt: options.generatedAt ?? new Date().toISOString(), scope, scopeLabel: scope.kind, repositories, dimensions: dimensionAssessments(repositories), rungs, currentRung, reviewedRung: null, coverage: inventoryCoverage, limitations: [...limitations] };
}
export function isReadinessAssessment(value: unknown): value is ReadinessAssessment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.model === READINESS_MODEL_VERSION && typeof candidate.generatedAt === "string" && Number.isInteger(candidate.currentRung) && Array.isArray(candidate.repositories) && Array.isArray(candidate.rungs) && Array.isArray(candidate.coverage);
}
