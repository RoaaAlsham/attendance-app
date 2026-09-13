import { DurableObject } from "cloudflare:workers";

const TOKEN_TTL_MS = 10_000;

interface SessionState {
  token: string;
  tokenExpiresAt: number;
  previousToken: string | null;
}

export class LectureSession extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Requests arrive two ways: forwarded unmodified from worker/index.ts
    // (full external path, e.g. /api/sessions/<id>/ws) for the WS upgrade,
    // or with a synthetic same-origin URL (e.g. "http://do/validate") from
    // application code calling env.SESSION.get(...).fetch(...) directly —
    // so match on suffix rather than an exact pathname.
    if (url.pathname.endsWith("/ws") && request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(url);
    }

    if (url.pathname.endsWith("/validate") && request.method === "POST") {
      return this.handleValidate(request);
    }

    if (url.pathname.endsWith("/notify") && request.method === "POST") {
      return this.handleNotify(request);
    }

    return new Response("not found", { status: 404 });
  }

  private async handleWebSocketUpgrade(url: URL): Promise<Response> {
    const role = url.searchParams.get("role");
    if (role !== "projector" && role !== "lecturer") {
      return new Response("role must be 'projector' or 'lecturer'", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [role]);

    await this.ensureRotationStarted();

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleValidate(request: Request): Promise<Response> {
    const body = (await request.json()) as { token?: string };
    const state = await this.getState();

    if (!state) {
      return Response.json({ valid: false, reason: "no active token" });
    }
    if (body.token === state.previousToken || Date.now() > state.tokenExpiresAt) {
      return Response.json({ valid: false, reason: "expired" });
    }
    if (body.token !== state.token) {
      return Response.json({ valid: false, reason: "mismatched token" });
    }
    return Response.json({ valid: true });
  }

  private async handleNotify(request: Request): Promise<Response> {
    const body = (await request.json()) as { studentName?: string };
    this.broadcast("lecturer", { type: "attendance", studentName: body.studentName });
    return Response.json({ ok: true });
  }

  private async ensureRotationStarted(): Promise<void> {
    const state = await this.getState();
    const alarm = await this.ctx.storage.getAlarm();
    if (state && alarm) return;

    await this.rotateToken();
  }

  async alarm(): Promise<void> {
    await this.rotateToken();
  }

  private async rotateToken(): Promise<void> {
    const previous = await this.getState();
    const state: SessionState = {
      token: crypto.randomUUID(),
      tokenExpiresAt: Date.now() + TOKEN_TTL_MS,
      previousToken: previous?.token ?? null,
    };
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now() + TOKEN_TTL_MS);
    this.broadcast("projector", { type: "qr", token: state.token });
  }

  private async getState(): Promise<SessionState | undefined> {
    return this.ctx.storage.get<SessionState>("state");
  }

  private broadcast(tag: string, message: unknown): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets(tag)) {
      ws.send(payload);
    }
  }
}
