import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { build } from "esbuild";

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
for (const entry of ["dist/core/schema.js", "dist/core/octokit.js", "dist/core/core.js", "dist/core/testing.js"]) {
  const result = await build({
    entryPoints: [entry], bundle: true, platform: "browser", format: "esm", write: false, metafile: true,
  });
  const imported = Object.values(result.metafile.inputs).flatMap((input) => input.imports.map((item) => item.path));
  assert.deepEqual(imported.filter((path) => builtins.has(path) || path.startsWith("node:")), [], `${entry} imports a Node built-in`);
}
console.log("browser-target portable export bundle tests passed");
