import { env } from "cloudflare:workers";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const userId = req.headers.get("x-user-id")!;
  const { id } = await context.params;

  const session = await env.DB.prepare(
    "SELECT lecturer_id AS lecturerId, ended_at AS endedAt FROM sessions WHERE id = ?"
  ).bind(id).first<{ lecturerId: string; endedAt: number | null }>();

  if (!session) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  if (session.lecturerId !== userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (session.endedAt) {
    return Response.json({ error: "session already ended" }, { status: 409 });
  }

  await env.DB.prepare("UPDATE sessions SET ended_at = unixepoch() WHERE id = ?").bind(id).run();

  return Response.json({ ok: true });
}
