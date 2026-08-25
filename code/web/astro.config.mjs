import { defineConfig } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
  site: "https://ai-outfitter.github.io",
  output: "server",
  adapter: node({ mode: "standalone" }),
  server: { host: process.env.LINK_HOST ?? "127.0.0.1" },
  vite: { server: { allowedHosts: [process.env.LINK_HOST ?? "127.0.0.1", "localhost"] } },
});
