import handler from "vinext/server/app-router-entry";
import { LectureSession } from "../src/durable-objects/lecture-session";
import { verifySession } from "../src/lib/session";

export { LectureSession };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const wsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/ws$/);

    if (request.headers.get("Upgrade") === "websocket" && wsMatch) {
      const sessionId = wsMatch[1];

      // This upgrade never reaches src/middleware.ts — it's intercepted here,
      // before vinext's routing — so the socket is authorized here or not at
      // all. Without this, anyone holding a session id could subscribe to the
      // projector feed and harvest live QR tokens remotely, which defeats the
      // point of requiring physical presence to read the code off a screen.
      const denied = await authorizeSocket(request, sessionId, env);
      if (denied) return denied;

      const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
      return stub.fetch(request);
    }

    return handler.fetch(request, env, ctx);
  },
};

async function authorizeSocket(
  request: Request,
  sessionId: string,
  env: Env,
): Promise<Response | null> {
  const token = request.headers.get("cookie")?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  const identity = token ? await verifySession(token) : null;
  if (!identity) return new Response("unauthorized", { status: 401 });

  const row = await env.DB.prepare("SELECT lecturer_id AS lecturerId FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ lecturerId: string }>();

  if (!row) return new Response("session not found", { status: 404 });
  if (row.lecturerId !== identity.userId) return new Response("forbidden", { status: 403 });

  return null;
}
