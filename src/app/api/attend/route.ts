import { env } from "cloudflare:workers";
import { haversineDistanceMeters } from "@/lib/geo";

const RATE_LIMIT_PER_MINUTE = 10;

export async function POST(req: Request) {
  const userId = req.headers.get("x-user-id")!;

  const body = (await req.json()) as {
    sessionId?: string;
    token?: string;
    lat?: number;
    lng?: number;
  };
  const { sessionId, token, lat, lng } = body;

  if (!sessionId || !token) {
    return Response.json({ error: "sessionId and token are required" }, { status: 400 });
  }

  const session = await env.DB.prepare(
    "SELECT ended_at AS endedAt, room_lat AS roomLat, room_lng AS roomLng, radius_m AS radiusM FROM sessions WHERE id = ?"
  ).bind(sessionId).first<{ endedAt: number | null; roomLat: number | null; roomLng: number | null; radiusM: number }>();

  if (!session) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  if (session.endedAt) {
    return Response.json({ error: "session ended" }, { status: 410 });
  }

  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";

  if (!(await checkRateLimit(ip))) {
    await flagAttempt(sessionId, userId, "rate_limited");
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  if (session.roomLat !== null && session.roomLng !== null) {
    const withinRange =
      lat !== undefined &&
      lng !== undefined &&
      haversineDistanceMeters(session.roomLat, session.roomLng, lat, lng) <= session.radiusM;

    if (!withinRange) {
      await flagAttempt(sessionId, userId, "outside_geofence");
      return Response.json({ error: "outside_geofence" }, { status: 422 });
    }
  }

  const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
  const validateRes = await stub.fetch("http://do/validate", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  const { valid, reason } = (await validateRes.json()) as { valid: boolean; reason?: string };

  if (!valid) {
    return Response.json({ error: "invalid_token", reason }, { status: 422 });
  }

  try {
    await env.DB.prepare(
      `INSERT INTO attendance (id, session_id, user_id, scanned_at, ip, lat, lng)
       VALUES (?, ?, ?, unixepoch(), ?, ?, ?)`
    ).bind(crypto.randomUUID(), sessionId, userId, ip, lat ?? null, lng ?? null).run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed")) {
      return Response.json({ error: "already_scanned" }, { status: 409 });
    }
    throw err;
  }

  const user = await env.DB.prepare("SELECT name FROM users WHERE id = ?")
    .bind(userId)
    .first<{ name: string }>();

  await stub.fetch("http://do/notify", {
    method: "POST",
    body: JSON.stringify({ studentName: user?.name ?? "Unknown" }),
  });

  return Response.json({ ok: true }, { status: 201 });
}

async function checkRateLimit(ip: string): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `${ip}:${bucket}`;

  try {
    const row = await env.DB.prepare(
      `INSERT INTO attend_rate_limits (id, count) VALUES (?, 1)
       ON CONFLICT(id) DO UPDATE SET count = count + 1
       RETURNING count`
    ).bind(key).first<{ count: number }>();

    return (row?.count ?? 0) <= RATE_LIMIT_PER_MINUTE;
  } catch {
    // Fail open. Rate limiting is a guard against abuse, not part of the
    // check-in contract — if its own bookkeeping fails, that must not cost a
    // student their attendance.
    return true;
  }
}

async function flagAttempt(sessionId: string, userId: string, reason: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO attendance_flags (id, session_id, user_id, reason) VALUES (?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), sessionId, userId, reason).run();
}
