import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const XDG_DATA = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "outfitter-link");
const XDG_CONFIG = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "outfitter-link");
const SCANS = join(XDG_DATA, "scans");

const LEVEL_REQUIREMENTS: Record<number, string[]> = {
  1: ["instructions"],
  2: ["shared-catalog", "catalog-consumed"],
  3: ["triggered-agents", "agent-review", "protected-landing", "session-capture"],
  4: ["bot-identity", "strict-governance"],
};

type Status = "met" | "unmet" | "unknown";
type Decision = { target: string; decision: "accepted" | "rejected"; decided_at: string };

const safePart = (value: string) => /^[A-Za-z0-9._+-]+$/.test(value) && value !== "." && value !== "..";
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

function scanDir(scope: string, scanId: string): string {
  if (!safePart(scope) || !safePart(scanId)) throw new Error("invalid scan identity");
  const path = join(SCANS, scope, scanId);
  if (!existsSync(join(path, "report.json")) || !existsSync(join(path, "scan.json")))
    throw new Error("scan not found");
  return path;
}

function reviewDir(scope: string, scanId: string, reviewId: string): string {
  if (!safePart(reviewId)) throw new Error("invalid review identity");
  const path = join(scanDir(scope, scanId), "reviews", reviewId);
  if (!existsSync(join(path, "review.json"))) throw new Error("review not found");
  return path;
}

export function listHistory() {
  if (!existsSync(SCANS)) return [];
  return readdirSync(SCANS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && safePart(entry.name))
    .flatMap((scope) =>
      readdirSync(join(SCANS, scope.name), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && safePart(entry.name))
        .map((entry) => {
          const dir = join(SCANS, scope.name, entry.name);
          const meta = readJson(join(dir, "scan.json"));
          const reviews = existsSync(join(dir, "reviews"))
            ? readdirSync(join(dir, "reviews"), { withFileTypes: true })
                .filter((item) => item.isDirectory() && existsSync(join(dir, "reviews", item.name, "review.json")))
                .map((item) => item.name)
            : [];
          return { ...meta, reviews };
        }),
    )
    .sort((a, b) => b.generated_at.localeCompare(a.generated_at));
}

function shell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sourceRoots(): { local: string[]; github: string[] } {
  try {
    const sources = readJson(join(XDG_CONFIG, "sources.json")).sources ?? [];
    return {
      local: sources.filter((s: any) => s.type === "folder").map((s: any) => resolve(s.target)),
      github: sources.filter((s: any) => s.type.startsWith("github-")).map((s: any) => s.target),
    };
  } catch {
    return { local: [], github: [] };
  }
}

export function prepareReview(scope: string, scanId: string) {
  const currentDir = scanDir(scope, scanId);
  const current = readJson(join(currentDir, "scan.json"));
  const sameScope = listHistory().filter((scan) => scan.scope === scope).reverse();
  const at = sameScope.findIndex((scan) => scan.scan_id === scanId);
  const previous = at > 0 ? sameScope[at - 1] : null;
  const initial = sameScope[0] ?? current;
  const report = readJson(join(currentDir, "report.json"));
  const org = report.orgs[0];
  const reviewId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomUUID().slice(0, 8)}`;
  const dir = join(currentDir, "reviews", reviewId);
  mkdirSync(dir, { recursive: true });
  const root = resolve(join(import.meta.dirname, "..", "..", "..", ".."));
  const schemaSource = join(root, "spec", "reviewed-evidence.v1.schema.json");
  const schemaPath = join(dir, "reviewed-evidence.schema.json");
  const promptPath = join(dir, "prompt.md");
  const resultPath = join(dir, "result.json");
  const roots = sourceRoots();
  const repositories = org.repos.map((repo: any) => `${org.org}/${repo.name}`);
  const schema = readFileSync(schemaSource, "utf8");
  const reportPath = (scan: any) => join(SCANS, scope, scan.scan_id, "report.json");
  const prompt = `# Link semantic evidence review\n\nInvestigate evidence the deterministic Link scanner missed. Read the current scan first, compare history when useful, and produce only JSON conforming exactly to the embedded schema.\n\n## Scan history\n\n- current: ${reportPath(current)}\n- previous: ${previous ? reportPath(previous) : "none"}\n- initial: ${reportPath(initial)}\n- history directory: ${join(SCANS, scope)}\n\n## Authorized scope\n\n- organization: ${org.org}\n- GitHub targets: ${[...new Set([...roots.github, ...repositories])].join(", ") || "none"}\n- registered local checkout roots: ${roots.local.join(", ") || "none"}\n\nYou MAY inspect those local roots read-only and use read-only \`gh\` commands for the named GitHub targets. You MUST NOT clone repositories, mutate any repository or forge resource, reveal credentials or session material, or inspect outside the named scope. Investigate scanner gaps semantically, especially custom-named review automation. Every claim MUST cite concrete evidence with a repository and a path, URL, or job/step/ruleset locator. Do not claim absence from an incomplete search.\n\nSet source_scan.id to \`${current.scan_id}\`, source_scan.fingerprint to \`${current.fingerprint}\`, and source_scan.generated_at to \`${current.generated_at}\`. Set scope.organization to \`${org.org}\`. Write the result to exactly \`${resultPath}\`.\n\nKnown scoring milestone IDs: ${org.milestones.map((m: any) => m.id).concat("agent-review").join(", ")}. Other target IDs are permitted only for recognized non-scoring capabilities. Target IDs MUST be unique.\n\n## Output schema\n\n\`\`\`json\n${schema.trim()}\n\`\`\`\n`;
  writeFileSync(promptPath, prompt);
  writeFileSync(schemaPath, schema);
  writeJson(join(dir, "review.json"), { version: "review/v1", review_id: reviewId, scope, scan_id: scanId, created_at: new Date().toISOString(), prompt_path: promptPath, schema_path: schemaPath, result_path: resultPath });
  writeJson(join(dir, "decisions.json"), { version: "review-decisions/v1", decisions: [] });
  const commands = {
    claude: `claude -p --output-format json --json-schema "$(cat ${shell(schemaPath)})" --allowedTools 'Read,Grep,Glob,Bash(gh:*)' < ${shell(promptPath)} > ${shell(resultPath)}`,
    codex: `codex exec --sandbox read-only --ask-for-approval never --output-schema ${shell(schemaPath)} -o ${shell(resultPath)} - < ${shell(promptPath)}`,
    pi: `outfitter run sdlc-report -- pi -p < ${shell(promptPath)} > ${shell(resultPath)}`,
    prompt: promptPath,
  };
  return { review_id: reviewId, scope, scan_id: scanId, commands, warning: "Pi read-only behavior is prompt-enforced because enabling Bash for gh cannot be command-scoped.", result_path: resultPath };
}

function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, any>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("unknown property in reviewed evidence");
}

function validateResult(raw: string, scan: any, report: any) {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw new Error("result must be raw JSON, not prose or fenced JSON"); }
  if (object(parsed) && object(parsed.structured_output)) parsed = parsed.structured_output;
  if (!object(parsed)) throw new Error("result must be an object");
  exact(parsed, ["version", "source_scan", "scope", "claims", "unresolved_questions", "evidence_limits"]);
  if (parsed.version !== "reviewed-evidence/v1" || !object(parsed.source_scan) || !object(parsed.scope)) throw new Error("unsupported reviewed-evidence contract");
  exact(parsed.source_scan, ["id", "fingerprint", "generated_at"]);
  exact(parsed.scope, ["organization", "repositories"]);
  if (parsed.source_scan.id !== scan.scan_id || parsed.source_scan.fingerprint !== scan.fingerprint || parsed.source_scan.generated_at !== scan.generated_at) throw new Error("result targets a stale or different scan");
  if (parsed.scope.organization !== report.orgs[0].org || !Array.isArray(parsed.scope.repositories)) throw new Error("result scope does not match the scan");
  if (!Array.isArray(parsed.claims) || !Array.isArray(parsed.unresolved_questions) || !Array.isArray(parsed.evidence_limits)) throw new Error("claims and limit fields must be arrays");
  const knownRepos = new Set(report.orgs[0].repos.map((repo: any) => `${report.orgs[0].org}/${repo.name}`));
  const knownTargets = new Map(report.orgs[0].milestones.map((milestone: any) => [milestone.id, milestone.status]));
  const targets = new Set<string>();
  for (const claim of parsed.claims) {
    if (!object(claim)) throw new Error("claim must be an object");
    exact(claim, ["target", "scanner_status", "proposed_status", "disposition", "confidence", "rationale", "evidence"]);
    if (typeof claim.target !== "string" || targets.has(claim.target)) throw new Error("duplicate or invalid claim target");
    targets.add(claim.target);
    if (!knownTargets.has(claim.target)) throw new Error(`unknown milestone: ${claim.target}`);
    if (!(["met", "unmet", "unknown"] as any[]).includes(claim.scanner_status) || !(["met", "unmet", "unknown"] as any[]).includes(claim.proposed_status) || !["confirm", "challenge", "supplement"].includes(claim.disposition)) throw new Error(`malformed claim ${claim.target}`);
    if (claim.scanner_status !== knownTargets.get(claim.target)) throw new Error(`scanner status mismatch for ${claim.target}`);
    if (typeof claim.confidence !== "number" || claim.confidence < 0 || claim.confidence > 1 || typeof claim.rationale !== "string" || !claim.rationale || !Array.isArray(claim.evidence) || claim.evidence.length === 0) throw new Error(`malformed claim ${claim.target}`);
    for (const evidence of claim.evidence) {
      if (!object(evidence)) throw new Error("evidence must be an object");
      exact(evidence, ["source_type", "repository", "path", "url", "locator", "observation"]);
      if (!knownRepos.has(evidence.repository) || typeof evidence.observation !== "string" || !evidence.observation || !(evidence.path || evidence.url || evidence.locator)) throw new Error(`malformed evidence for ${claim.target}`);
    }
  }
  return parsed;
}

export function loadReview(scope: string, scanId: string, reviewId: string) {
  const dir = reviewDir(scope, scanId, reviewId);
  const scan = readJson(join(scanDir(scope, scanId), "scan.json"));
  const report = readJson(join(scanDir(scope, scanId), "report.json"));
  const resultPath = join(dir, "result.json");
  if (!existsSync(resultPath)) return { status: "waiting", review: readJson(join(dir, "review.json")) };
  const result = validateResult(readFileSync(resultPath, "utf8"), scan, report);
  const decisions = readJson(join(dir, "decisions.json")).decisions as Decision[];
  return { status: "loaded", review: readJson(join(dir, "review.json")), result, decisions, scores: reviewedScores(report, result, decisions) };
}

export function decideClaim(scope: string, scanId: string, reviewId: string, target: string, decision: "accepted" | "rejected") {
  const loaded: any = loadReview(scope, scanId, reviewId);
  if (loaded.status !== "loaded" || !loaded.result.claims.some((claim: any) => claim.target === target)) throw new Error("claim not found");
  const path = join(reviewDir(scope, scanId, reviewId), "decisions.json");
  const current = loaded.decisions.filter((item: Decision) => item.target !== target);
  current.push({ target, decision, decided_at: new Date().toISOString() });
  writeJson(path, { version: "review-decisions/v1", decisions: current });
  return loadReview(scope, scanId, reviewId);
}

function reviewedScores(report: any, result: any, decisions: Decision[]) {
  const accepted = new Set(decisions.filter((item) => item.decision === "accepted").map((item) => item.target));
  return report.orgs.map((org: any) => {
    const statuses = new Map<string, Status>(org.milestones.map((m: any) => [m.id, m.status]));
    for (const claim of result.claims) if (accepted.has(claim.target) && Object.values(LEVEL_REQUIREMENTS).flat().includes(claim.target)) statuses.set(claim.target, claim.proposed_status);
    let level = 0;
    for (const rung of Object.keys(LEVEL_REQUIREMENTS).map(Number).sort()) {
      if (LEVEL_REQUIREMENTS[rung].every((id) => statuses.get(id) === "met")) level = rung;
      else break;
    }
    return { organization: org.org, scanner_level: org.org_level, reviewed_level: level };
  });
}

export const reviewInternals = { validateResult, reviewedScores, LEVEL_REQUIREMENTS };
