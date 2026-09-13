import { env } from "cloudflare:workers";
import { hashPassword } from "@/lib/password";

export async function POST(req: Request) {
  const body = (await req.json()) as { name?: string; email?: string; password?: string; role?: string };
  const { name, email, password, role } = body;

  if (!name || !email || !password || (role !== "student" && role !== "lecturer")) {
    return Response.json({ error: "name, email, password, and role ('student' | 'lecturer') are required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);

  try {
    await env.DB.prepare(
      "INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, name, email, passwordHash, role).run();
  } catch {
    return Response.json({ error: "email already in use" }, { status: 409 });
  }

  return Response.json({ id, name, email, role }, { status: 201 });
}
