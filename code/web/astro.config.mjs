import { defineConfig } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
  site: "https://ai-outfitter.github.io",
  output: "server",
  adapter: node({ mode: "standalone" }),
});
