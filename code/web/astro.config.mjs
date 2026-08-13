import { defineConfig } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
  site: "https://ai-outfitter.github.io",
  output: "server",
  adapter: node({ mode: "standalone" }),
  // Local dev convenience: listen on all interfaces and accept any hostname.
  server: { host: true },
  vite: { server: { allowedHosts: true } },
});
