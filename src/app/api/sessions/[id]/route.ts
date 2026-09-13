import { env } from "cloudflare:workers";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  const session = await env.DB.prepare(
    `SELECT sessions.id AS id, sessions.course_id AS courseId, sessions.lecturer_id AS lecturerId,
            sessions.started_at AS startedAt, sessions.ended_at AS endedAt,
            sessions.room_lat AS roomLat, sessions.room_lng AS roomLng, sessions.radius_m AS radiusM,
            courses.name AS courseName, courses.code AS courseCode
     FROM sessions JOIN courses ON courses.id = sessions.course_id
     WHERE sessions.id = ?`
  ).bind(id).first();

  if (!session) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }

  return Response.json(session);
}
