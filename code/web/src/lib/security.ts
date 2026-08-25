import { randomBytes, timingSafeEqual } from "node:crypto";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const REQUEST_TOKEN = process.env.LINK_REQUEST_TOKEN ?? randomBytes(24).toString("hex");

export const requestToken = () => REQUEST_TOKEN;

const equal = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function authorizeRequest(request: Request): string | null {
  const url = new URL(request.url);
  const host = (request.headers.get("host") ?? "").split(":")[0];
  const configuredHost = process.env.LINK_HOST ?? "127.0.0.1";
  const nonLoopback = !LOOPBACK.has(configuredHost);
  if (!LOOPBACK.has(host) && host !== configuredHost) return "untrusted host";
  if (nonLoopback) {
    const access = process.env.LINK_ACCESS_TOKEN;
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!access || !equal(access, supplied)) return "non-loopback serving requires a valid access token";
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (!origin || new URL(origin).origin !== url.origin) return "untrusted or missing origin";
    const token = request.headers.get("x-link-request-token") ?? "";
    if (!equal(REQUEST_TOKEN, token)) return "missing or invalid request token";
  }
  return null;
}
