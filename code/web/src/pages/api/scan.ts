import type { APIRoute } from "astro";
import { runScan } from "../../lib/server-data.ts";

export const prerender = false;

export const POST: APIRoute = async () => {
  const result = await runScan();
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
};
