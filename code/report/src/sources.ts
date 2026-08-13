import { parse as parseYaml } from "yaml";
import { DeclaredSource } from "./schema.js";

// Dotagents settings permit uri and path sources as well as GitHub sources.
// Extract the GitHub subset entry by entry so one legal sibling cannot hide a
// declaration the scanner measures. Only the document/list/map structure is
// required; unsupported map entries are ignored.
export function parseDeclaredSources(raw: string): DeclaredSource[] | null {
  try {
    const doc = parseYaml(raw);
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
    const sources = (doc as Record<string, unknown>).sources;
    if (!Array.isArray(sources)) return null;
    if (
      sources.some(
        (source) => source === null || typeof source !== "object" || Array.isArray(source),
      )
    )
      return null;

    return sources.flatMap((source) => {
      const entry = source as Record<string, unknown>;
      if (typeof entry.github !== "string") return [];
      const declared: DeclaredSource = { github: entry.github };
      if (
        typeof entry.ref === "string" ||
        typeof entry.ref === "number" ||
        typeof entry.ref === "boolean"
      )
        declared.ref = String(entry.ref);
      return [declared];
    });
  } catch {
    return null;
  }
}
export function declaredSourceSignals(raw: string | null | undefined): {
  declared_sources: DeclaredSource[] | null;
  settings_unparseable: boolean;
} {
  if (raw === undefined) return { declared_sources: null, settings_unparseable: false };
  if (raw === null) return { declared_sources: null, settings_unparseable: true };
  const declared_sources = parseDeclaredSources(raw);
  return { declared_sources, settings_unparseable: declared_sources === null };
}

export type ResolvedDeclaredSource<T> = {
  source: DeclaredSource;
  identity: string | null;
  value: T | null;
  trackingOrgCatalog: boolean;
};

export function githubSourceIdentity(source: string): string | null {
  const parts = source.trim().split("/");
  return parts.length === 2 && parts.every(Boolean)
    ? `github:${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`
    : null;
}

// Resolution is deliberately scan-local: a declaration is evidence of what
// a repository intends to inherit, while the matched repository supplies the
// only contents this read-only scanner can verify. The ref remains evidence
// but is not fetched or checked against the scanned copy.
export function resolvePinnedGithubSources<T>(
  declaredSources: DeclaredSource[] | null,
  sourceValues: ReadonlyMap<string, T>,
  unpinnedOrgCatalogs: ReadonlySet<string> = new Set(),
): ResolvedDeclaredSource<T>[] {
  return (declaredSources ?? [])
    .map((source) => {
      const identity = githubSourceIdentity(source.github);
      const trackingOrgCatalog =
        source.ref === undefined && identity !== null && unpinnedOrgCatalogs.has(identity);
      return {
        source,
        identity,
        value: identity ? (sourceValues.get(identity) ?? null) : null,
        trackingOrgCatalog,
      };
    })
    .filter((resolved) => resolved.source.ref !== undefined || resolved.trackingOrgCatalog);
}

export type CatalogSourceFinding =
  | {
      kind: "competing-source";
      repo: string;
      source: string;
      repoRef: string | null;
      catalogRef: string | null;
    }
  | {
      kind: "pinned-org-catalog";
      repo: string;
      source: string;
      repoRef: string;
    };

type RepoSources = { name: string; declared_sources: DeclaredSource[] | null };

// Compare only evidence the scan read. A missing settings file is not a
// negative fact, while a declaration that duplicates the org catalog or pins
// the org catalog is directly observable and actionable.
export function catalogSourceFindings(
  org: string,
  catalogSources: DeclaredSource[] | null,
  repos: RepoSources[],
): CatalogSourceFinding[] {
  const orgCatalog = `${org}/.agents`.toLowerCase();
  const catalogBySource = new Map(
    (catalogSources ?? []).map((source) => [source.github.toLowerCase(), source]),
  );
  const findings: CatalogSourceFinding[] = [];

  for (const repo of repos) {
    if (repo.declared_sources === null) continue;
    for (const source of repo.declared_sources) {
      const key = source.github.toLowerCase();
      if (key === orgCatalog && source.ref !== undefined) {
        findings.push({
          kind: "pinned-org-catalog",
          repo: repo.name,
          source: source.github,
          repoRef: source.ref,
        });
      }
      const catalogSource = catalogBySource.get(key);
      if (catalogSource !== undefined) {
        findings.push({
          kind: "competing-source",
          repo: repo.name,
          source: source.github,
          repoRef: source.ref ?? null,
          catalogRef: catalogSource.ref ?? null,
        });
      }
    }
  }
  return findings;
}
