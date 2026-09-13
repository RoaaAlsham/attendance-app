import { env } from "cloudflare:workers";

export async function POST(req: Request) {
  const userId = req.headers.get("x-user-id")!;
  const body = (await req.json()) as {
    courseId?: string;
    roomLat?: number;
    roomLng?: number;
    radiusM?: number;
  };
  const { courseId, roomLat, roomLng, radiusM } = body;

  if (!courseId) {
    return Response.json({ error: "courseId is required" }, { status: 400 });
  }

  const course = await env.DB.prepare(
    "SELECT id FROM courses WHERE id = ? AND lecturer_id = ?"
  ).bind(courseId, userId).first();

  if (!course) {
    return Response.json({ error: "course not found" }, { status: 404 });
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sessions (id, course_id, lecturer_id, started_at, room_lat, room_lng, radius_m)
     VALUES (?, ?, ?, unixepoch(), ?, ?, ?)`
  ).bind(id, courseId, userId, roomLat ?? null, roomLng ?? null, radiusM ?? 50).run();

  return Response.json({ id }, { status: 201 });
}
