import { env } from "cloudflare:workers";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createSession(userId: string) {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;

  await env.DB.prepare(
    "INSERT INTO auth_sessions (id, user_id, expires_at) VALUES (?, ?, ?)"
  ).bind(tokenHash, userId, expiresAt).run();

  return { token, expiresAt };
}

export async function verifySession(token: string) {
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT auth_sessions.user_id AS userId, users.role AS role, auth_sessions.expires_at AS expiresAt
     FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id
     WHERE auth_sessions.id = ?`
  ).bind(tokenHash).first<{ userId: string; role: string; expiresAt: number }>();

  if (!row) return null;
  if (row.expiresAt < Math.floor(Date.now() / 1000)) {
    await env.DB.prepare("DELETE FROM auth_sessions WHERE id = ?").bind(tokenHash).run();
    return null;
  }
  return { userId: row.userId, role: row.role };
}

export async function revokeSession(token: string) {
  await env.DB.prepare("DELETE FROM auth_sessions WHERE id = ?")
    .bind(await sha256Hex(token)).run();
}

export async function revokeAllSessionsForUser(userId: string) {
  await env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(userId).run();
}
