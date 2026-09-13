import { env } from "cloudflare:workers";

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const userId = req.headers.get("x-user-id")!;
  const { id } = await context.params;

  const session = await env.DB.prepare(
    "SELECT lecturer_id AS lecturerId FROM sessions WHERE id = ?"
  ).bind(id).first<{ lecturerId: string }>();

  if (!session) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  if (session.lecturerId !== userId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const { results } = await env.DB.prepare(
    `SELECT attendance.id AS id, attendance.user_id AS userId, users.name AS name,
            attendance.scanned_at AS scannedAt
     FROM attendance JOIN users ON users.id = attendance.user_id
     WHERE attendance.session_id = ?
     ORDER BY attendance.scanned_at ASC`
  ).bind(id).all();

  return Response.json(results);
}
