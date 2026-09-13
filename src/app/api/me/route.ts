import { env } from "cloudflare:workers";

export async function GET(req: Request) {
  const userId = req.headers.get("x-user-id");
  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const user = await env.DB.prepare(
    "SELECT id, name, email, role FROM users WHERE id = ?"
  ).bind(userId).first<{ id: string; name: string; email: string; role: string }>();

  if (!user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  return Response.json(user);
}
