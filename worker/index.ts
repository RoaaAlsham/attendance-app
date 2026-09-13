import handler from "vinext/server/app-router-entry";
import { LectureSession } from "../durable-objects/lecture-session";

export { LectureSession };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const wsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/ws$/);

    if (request.headers.get("Upgrade") === "websocket" && wsMatch) {
      const sessionId = wsMatch[1];
      const stub = env.SESSION.get(env.SESSION.idFromName(sessionId));
      return stub.fetch(request);
    }

    return handler.fetch(request, env, ctx);
  },
};
