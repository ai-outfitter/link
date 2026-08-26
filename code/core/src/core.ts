import type { RepositoryObservation } from "./schema.js";

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
