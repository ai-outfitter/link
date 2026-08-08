// Server-side data access: the report and workflow JSON are read per
// request (not bundled at build time) so a rescan is visible on reload,
// and the source registry is the same XDG file the report CLI owns.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB_DATA = join(HERE, "..", "data");
const REPORT_DIR = join(HERE, "..", "..", "..", "report");
const XDG_CONFIG = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "outfitter-link",
);
const XDG_DATA = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "outfitter-link",
);
const SOURCES_FILE = join(XDG_CONFIG, "sources.json");

export type Source = { type: "github-org" | "folder"; target: string };

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function loadReport(): any | null {
  return readJson(join(WEB_DATA, "report.json")) ?? readJson(join(XDG_DATA, "report.json"));
}

export function loadWorkflows(): any[] {
  return readJson(join(WEB_DATA, "workflows.json")) ?? [];
}

export function loadSources(): Source[] {
  const doc = readJson(SOURCES_FILE);
  return Array.isArray(doc?.sources) ? doc.sources : [];
}

export function addSource(target: string): { sources: Source[]; added: Source } {
  const expanded = target.startsWith("~") ? join(homedir(), target.slice(1)) : target;
  const added: Source = existsSync(expanded)
    ? { type: "folder", target: resolve(expanded) }
    : { type: "github-org", target };
  const sources = loadSources();
  if (!sources.some((s) => s.type === added.type && s.target === added.target)) {
    sources.push(added);
    mkdirSync(XDG_CONFIG, { recursive: true });
    writeFileSync(SOURCES_FILE, JSON.stringify({ sources }, null, 2) + "\n");
  }
  return { sources, added };
}

export function removeSource(target: string): Source[] {
  const sources = loadSources().filter((s) => s.target !== target);
  mkdirSync(XDG_CONFIG, { recursive: true });
  writeFileSync(SOURCES_FILE, JSON.stringify({ sources }, null, 2) + "\n");
  return sources;
}

function bunBinary(): string {
  const candidate = join(homedir(), ".bun", "bin", "bun");
  return existsSync(candidate) ? candidate : "bun";
}

// Run the scanner over the registered sources; resolves when the report
// files are rewritten. Local-development tool: the caller is the person
// whose machine this is.
export async function runScan(): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      bunBinary(),
      ["run", "src/index.ts"],
      { cwd: REPORT_DIR, timeout: 5 * 60 * 1000 },
    );
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (error: any) {
    return { ok: false, output: String(error?.stderr ?? error) };
  }
}
