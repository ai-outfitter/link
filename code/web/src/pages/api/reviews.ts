import type { APIRoute } from "astro";
import { decideClaim, listHistory, loadReview, prepareReview } from "../../lib/reviews.ts";

export const prerender = false;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const fail = (error: unknown) => json({ error: error instanceof Error ? error.message : String(error) }, 400);

export const GET: APIRoute = ({ url }) => {
  const scope = url.searchParams.get("scope");
  const scan = url.searchParams.get("scan");
  const review = url.searchParams.get("review");
  try { return scope && scan && review ? json(loadReview(scope, scan, review)) : json({ scans: listHistory() }); }
  catch (error) { return fail(error); }
};

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  try { return json(prepareReview(body.scope, body.scan_id), 201); }
  catch (error) { return fail(error); }
};

export const PATCH: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  try {
    if (!(["accepted", "rejected"] as any[]).includes(body.decision)) throw new Error("decision must be accepted or rejected");
    return json(decideClaim(body.scope, body.scan_id, body.review_id, body.target, body.decision));
  } catch (error) { return fail(error); }
};
