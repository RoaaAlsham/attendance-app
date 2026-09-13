import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySession } from "@/lib/session";

export const config = {
  matcher: ["/api/courses/:path*", "/api/sessions/:path*", "/api/me", "/api/attend", "/dashboard/:path*"],
};

export async function middleware(req: NextRequest) {
  const token = req.cookies.get("session")?.value;
  const identity = token ? await verifySession(token) : null;
  if (!identity) return unauthorized(req);

  const headers = new Headers(req.headers);
  headers.set("x-user-id", identity.userId);
  headers.set("x-user-role", identity.role);

  if (
    (isLecturerOnly(req) && identity.role !== "lecturer") ||
    (isStudentOnly(req) && identity.role !== "student")
  ) {
    return forbidden(req);
  }
  return NextResponse.next({ request: { headers } });
}

async function unauthorized(req: NextRequest) {
  await drainBody(req);
  return req.nextUrl.pathname.startsWith("/api/")
    ? new NextResponse(null, { status: 401 })
    : NextResponse.redirect(new URL("/login", req.url));
}

async function forbidden(req: NextRequest) {
  await drainBody(req);
  return new NextResponse(null, { status: 403 });
}

/**
 * Rejecting a request without reading its body leaves unread bytes on a
 * keep-alive connection, which breaks the *next* request that reuses it.
 * Only safe on paths that never reach a route handler.
 */
async function drainBody(req: NextRequest) {
  try {
    await req.arrayBuffer();
  } catch {
    // no body to drain
  }
}

function isLecturerOnly(req: NextRequest) {
  const { pathname } = req.nextUrl;
  return pathname.startsWith("/dashboard")
    || (pathname.startsWith("/api/courses") && req.method === "POST")
    || (pathname === "/api/sessions" && req.method === "POST")
    || (pathname.startsWith("/api/sessions/") && pathname.endsWith("/end") && req.method === "POST")
    || (pathname.startsWith("/api/sessions/") && pathname.endsWith("/attendance") && req.method === "GET");
}

function isStudentOnly(req: NextRequest) {
  return req.nextUrl.pathname === "/api/attend" && req.method === "POST";
}
