import { defineMiddleware } from "astro:middleware";
import { authorizeRequest } from "./lib/security.ts";

export const onRequest = defineMiddleware(async ({ request }, next) => {
  const error = authorizeRequest(request);
  if (error) return new Response(JSON.stringify({ error }), { status: 403, headers: { "content-type": "application/json" } });
  return next();
});
