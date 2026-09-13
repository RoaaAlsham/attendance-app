import { env } from "cloudflare:workers";
import { verifyPassword } from "@/lib/password";
import { createSession } from "@/lib/session";

export async function POST(req: Request) {
  const body = (await req.json()) as { email?: string; password?: string };
  const { email, password } = body;

  if (!email || !password) {
    return Response.json({ error: "email and password are required" }, { status: 400 });
  }

  const user = await env.DB.prepare(
    "SELECT id, name, email, password_hash, role FROM users WHERE email = ?"
  ).bind(email).first<{ id: string; name: string; email: string; password_hash: string; role: string }>();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return Response.json({ error: "invalid email or password" }, { status: 401 });
  }

  const { token, expiresAt } = await createSession(user.id);
  const res = Response.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  res.headers.set(
    "Set-Cookie",
    `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Expires=${new Date(expiresAt * 1000).toUTCString()}`
  );
  return res;
}
