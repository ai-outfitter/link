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
