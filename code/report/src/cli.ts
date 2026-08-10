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

async function web(): Promise<number> {
  const root = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const webDir = root ? join(root, "code", "web") : null;
  if (!webDir || !existsSync(join(webDir, "package.json"))) {
    console.error(
      "link web needs a repository checkout: the Astro site is not part of the\n" +
        "published package. Clone ai-outfitter/link, then run `npm --prefix code/web run dev`.",
    );
    return 2;
  }
  const proc = spawn("npm", ["--prefix", webDir, "run", "dev"], { stdio: "inherit" });
  return new Promise((resolve) => proc.on("exit", (code) => resolve(code ?? 0)));
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
