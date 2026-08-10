#!/usr/bin/env node
// `link` command entry point. Runs on node (npx) and on Bun (bunx), which
// starts faster; nothing here may use a Bun-only global.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runReport } from "./index.js";

const USAGE = `link — audit organizations against the Outfitter SDLC governance baseline

Usage:
  link report [<org-or-path>...] [--out <dir>]   scan and write report.json
  link report add <org-or-path>...               register a source, then scan
  link web                                       serve the report (needs a checkout)

The scan is read-only: it lists repositories, reads git trees, and reads
effective branch rules. It changes nothing.

Requires an authenticated \`gh\` CLI on PATH. Sources are GitHub orgs or local
folders; a bare \`link report\` scans every registered source.

  link report ai-outfitter
  link report ai-outfitter --out ~/repos/ai-outfitter/.agents/reports/sdlc/2026-08-10-initial
`;

function findPackageRoot(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "governance", "sdlc-baseline.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function run(cmd: string, args: string[], opts: object = {}): Promise<number> {
  const proc = spawn(cmd, args, { stdio: "inherit", ...opts });
  return new Promise((resolve) => proc.on("exit", (code) => resolve(code ?? 0)));
}

async function web(): Promise<number> {
  const root = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

  // The published package ships the site prebuilt: one bundled server file
  // beside its client assets, needing no node_modules and no Astro at run
  // time. PORT is the adapter's own knob, so it passes straight through.
  const bundled = root ? join(root, "dist-web", "server", "entry.mjs") : null;
  if (bundled && existsSync(bundled)) {
    const port = process.env.PORT ?? "4321";
    console.error(`link web → http://localhost:${port}`);
    return run(process.execPath, [bundled], { env: { ...process.env, PORT: port } });
  }

  // A checkout with no built site: the Astro dev server gives hot reload,
  // but only once its dependencies are installed.
  const webDir = root ? join(root, "code", "web") : null;
  if (webDir && existsSync(join(webDir, "package.json"))) {
    if (!existsSync(join(webDir, "node_modules"))) {
      console.error(
        `the site's dependencies are not installed. Run:\n  npm --prefix ${webDir} install`,
      );
      return 2;
    }
    return run("npm", ["--prefix", webDir, "run", "dev"]);
  }

  console.error(
    "link web found no site to serve: neither a prebuilt dist-web/ nor a\n" +
      "code/web checkout. Reinstall the package, or clone ai-outfitter/link.",
  );
  return 2;
}

const argv = process.argv.slice(2);
const command = argv[0];

let code: number;
if (command === "report") {
  code = await runReport(argv.slice(1));
} else if (command === "web") {
  code = await web();
} else if (command === "help" || command === "--help" || command === "-h" || !command) {
  console.log(USAGE);
  code = command ? 0 : 2;
} else {
  console.error(`unknown command: ${command}\n\n${USAGE}`);
  code = 2;
}
process.exit(code);
