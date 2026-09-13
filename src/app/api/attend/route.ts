import { env } from "cloudflare:workers";

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
    "SELECT ended_at AS endedAt FROM sessions WHERE id = ?"
  ).bind(sessionId).first<{ endedAt: number | null }>();

  if (!session) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  if (session.endedAt) {
    return Response.json({ error: "session ended" }, { status: 410 });
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

  const ip = req.headers.get("cf-connecting-ip");

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
