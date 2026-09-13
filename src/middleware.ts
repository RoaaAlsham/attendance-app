import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySession } from "@/lib/session";

export const config = {
  matcher: ["/api/courses/:path*", "/api/sessions/:path*", "/api/me", "/dashboard/:path*"],
};

export async function middleware(req: NextRequest) {
  const token = req.cookies.get("session")?.value;
  const identity = token ? await verifySession(token) : null;
  if (!identity) return unauthorized(req);

  const headers = new Headers(req.headers);
  headers.set("x-user-id", identity.userId);
  headers.set("x-user-role", identity.role);

  if (isLecturerOnly(req) && identity.role !== "lecturer") {
    return new NextResponse(null, { status: 403 });
  }
  return NextResponse.next({ request: { headers } });
}

function unauthorized(req: NextRequest) {
  return req.nextUrl.pathname.startsWith("/api/")
    ? new NextResponse(null, { status: 401 })
    : NextResponse.redirect(new URL("/login", req.url));
}

function isLecturerOnly(req: NextRequest) {
  const { pathname } = req.nextUrl;
  return pathname.startsWith("/dashboard")
    || (pathname.startsWith("/api/courses") && req.method === "POST")
    || (pathname === "/api/sessions" && req.method === "POST")
    || (pathname.startsWith("/api/sessions/") && pathname.endsWith("/end") && req.method === "POST")
    || (pathname.startsWith("/api/sessions/") && pathname.endsWith("/attendance") && req.method === "GET");
}
