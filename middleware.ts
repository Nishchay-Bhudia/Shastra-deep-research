import { jwtVerify } from "jose";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "shastra_session";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic =
    pathname === "/login" ||
    pathname.startsWith("/setup") ||
    pathname.startsWith("/api/auth/");

  if (
    isPublic ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt"
  ) {
    return NextResponse.next();
  }

  const secret = process.env.SESSION_SECRET;
  const appPassword = process.env.APP_ACCESS_PASSWORD;
  if (!secret || secret.length < 32 || !appPassword) {
    return NextResponse.redirect(new URL("/setup", request.url));
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (token) {
    try {
      await jwtVerify(token, new TextEncoder().encode(secret), {
        algorithms: ["HS256"],
        issuer: "shastra-deep-research",
        audience: "shastra-app",
      });
      return NextResponse.next();
    } catch {
      // Invalid or expired cookies are treated as signed out.
    }
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
