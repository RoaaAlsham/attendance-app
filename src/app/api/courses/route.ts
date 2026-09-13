import { env } from "cloudflare:workers";

export async function POST(req: Request) {
  const userId = req.headers.get("x-user-id")!;
  const body = (await req.json()) as { name?: string; code?: string };
  const { name, code } = body;

  if (!name || !code) {
    return Response.json({ error: "name and code are required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO courses (id, name, code, lecturer_id) VALUES (?, ?, ?, ?)"
  ).bind(id, name, code, userId).run();

  return Response.json({ id, name, code, lecturerId: userId }, { status: 201 });
}

export async function GET(req: Request) {
  const userId = req.headers.get("x-user-id")!;
  const { results } = await env.DB.prepare(
    "SELECT id, name, code, lecturer_id AS lecturerId FROM courses WHERE lecturer_id = ? ORDER BY name"
  ).bind(userId).all();

  return Response.json(results);
}
