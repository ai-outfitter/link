import type { ReadinessAssessment, RepositoryObservation } from "./schema.js";
export { assessGitHubRepository, assessGitHubScope, capabilityDefinitions, isReadinessAssessment } from "./assessment.js";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalizeObservation(observation: RepositoryObservation): string {
  return JSON.stringify(canonicalValue(observation));
}

export async function fingerprintObservation(observation: RepositoryObservation): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeObservation(observation));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalizeAssessment(assessment: ReadinessAssessment): string { return JSON.stringify(canonicalValue(assessment)) }
export async function fingerprintAssessment(assessment: ReadinessAssessment): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalizeAssessment(assessment)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
