import type { APIRoute } from "astro";
import { addSource, loadSources, removeSource } from "../../lib/server-data.ts";

export const prerender = false;

export const GET: APIRoute = () =>
  new Response(JSON.stringify({ sources: loadSources() }), {
    headers: { "content-type": "application/json" },
  });

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  const target = typeof body?.target === "string" ? body.target.trim() : "";
  if (!target) {
    return new Response(JSON.stringify({ error: "target required" }), { status: 400 });
  }
  const result = addSource(target);
  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json" },
  });
};

export const DELETE: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  const target = typeof body?.target === "string" ? body.target.trim() : "";
  if (!target) {
    return new Response(JSON.stringify({ error: "target required" }), { status: 400 });
  }
  return new Response(JSON.stringify({ sources: removeSource(target) }), {
    headers: { "content-type": "application/json" },
  });
};
