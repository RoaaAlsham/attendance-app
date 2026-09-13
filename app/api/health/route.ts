import { env } from "cloudflare:workers";

export async function GET() {
  const result = await env.DB.prepare("SELECT 1").first();
  return Response.json({ ok: true, result });
}
