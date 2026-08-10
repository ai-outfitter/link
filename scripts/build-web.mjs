#!/usr/bin/env node
// Build the Astro site into a form the published package can serve.
//
// Astro's node adapter emits dist/server/entry.mjs with bare imports, so it
// needs node_modules at run time. Bundling it removes that: one file, no
// dependencies, no Astro in the published package.
//
// The client/ directory keeps its position beside server/, because the
// adapter resolves static assets relative to the entry's own URL. Flattening
// the layout serves the pages and 404s every asset.
//
// Runs from prepack, not prepare: prepare fires on every `npm ci`, which
// would pull the site's ~90 MB of dev dependencies into the Docker build and
// every contributor's first install.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "code", "web");
const OUT = join(ROOT, "dist-web");

const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });

if (!existsSync(join(WEB, "node_modules"))) {
  console.log("build:web — installing site dependencies");
  sh("npm", ["ci"], WEB);
}

console.log("build:web — astro build");
sh("npx", ["astro", "build"], WEB);

console.log("build:web — bundling the server");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "server"), { recursive: true });

// The alias matters: the generated bundle already imports `createRequire`
// under its own name, and a second plain import of it is a redeclaration
// SyntaxError at load. The banner itself is required — bundled CJS
// dependencies call `require` at run time, which an ESM output has no
// binding for.
sh(
  "npx",
  [
    "esbuild",
    join(WEB, "dist", "server", "entry.mjs"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${join(OUT, "server", "entry.mjs")}`,
    "--banner:js=import{createRequire as __lnkCR}from'node:module';const require=__lnkCR(import.meta.url);",
  ],
  ROOT,
);

cpSync(join(WEB, "dist", "client"), join(OUT, "client"), { recursive: true });
console.log(`build:web — wrote ${OUT}`);
