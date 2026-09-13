import { revokeSession } from "@/lib/session";

export async function POST(req: Request) {
  const token = req.headers.get("cookie")?.match(/session=([^;]+)/)?.[1];
  if (token) await revokeSession(token);
  const res = Response.json({ ok: true });
  res.headers.set("Set-Cookie", "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return res;
}
