// Server-side data access: the report and workflow JSON are read per
// request (not bundled at build time) so a rescan is visible on reload,
// and the source registry is the same XDG file the report CLI owns.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// Checkout-only: the Astro dev server reads its own source tree. In the
// published package this directory does not exist, and XDG is the only copy.
const WEB_DATA = join(HERE, "..", "data");

// The scanner lives beside the catalog payload, at the package root. This
// file is bundled into dist-web/server/entry.mjs when packaged and runs from
// code/web/src/lib in the dev server, so walk up to the payload rather than
// counting directories — the same rule the CLI follows.
function findRoot(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "governance", "sdlc-baseline.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const XDG_CONFIG = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "outfitter-link",
);
const XDG_DATA = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "outfitter-link",
);
const SOURCES_FILE = join(XDG_CONFIG, "sources.json");

export type Source = { type: "github-org" | "github-repo" | "folder"; target: string };
const OWNER_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Three places, in the order they are likely to be current.
//
// XDG first: every scan writes there. Then the working directory, which is
// what makes the container work — `docker run … report` writes to the bind
// mount and that container's XDG dies with it, so /work holds the only copy
// the next `docker run … web` can see. The source tree is last, for the
// checkout dev loop before anything has been scanned.
function readData(name: string): any | null {
  return (
    readJson(join(XDG_DATA, name)) ??
    readJson(join(process.cwd(), name)) ??
    readJson(join(WEB_DATA, name))
  );
}

export function loadReport(): any | null {
  return readData("report.json");
}

export function loadWorkflows(): any[] {
  return readData("workflows.json") ?? [];
}

export function loadSources(): Source[] {
  const doc = readJson(SOURCES_FILE);
  return Array.isArray(doc?.sources) ? doc.sources : [];
}

export function addSource(target: string): { sources: Source[]; added: Source } {
  const expanded = target.startsWith("~") ? join(homedir(), target.slice(1)) : target;
  const added: Source = existsSync(expanded)
    ? { type: "folder", target: resolve(expanded) }
    : OWNER_REPO.test(target)
      ? { type: "github-repo", target }
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

// Run the scanner over the registered sources; resolves when the report
// files are rewritten. Local-development tool: the caller is the person
// whose machine this is.
//
// This spawns the same `dist/cli.js` a terminal user runs, on the node that
// is already running this server — never Bun, which the package does not
// require, and never the TypeScript source, which it does not ship. `--out`
// is XDG rather than the process CWD, so a rescan writes only where the site
// reads and never litters the directory the user launched `link web` from.
export async function runScan(): Promise<{ ok: boolean; output: string }> {
  const root = findRoot(HERE);
  const cli = root ? join(root, "dist", "cli.js") : null;
  if (!cli || !existsSync(cli)) {
    return {
      ok: false,
      output:
        "cannot locate the scanner: dist/cli.js is missing. In a checkout, run `npm run build` first.",
    };
  }
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [cli, "report", "--out", XDG_DATA],
      { timeout: 5 * 60 * 1000 },
    );
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (error: any) {
    return { ok: false, output: String(error?.stderr ?? error) };
  }
}
