import { SignJWT } from "jose";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({ password: z.string().min(1).max(512) });
const COOKIE_NAME = "shastra_session";
const SESSION_SECONDS = 60 * 60 * 12;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

// Best-effort, per-instance brute-force throttle for the shared password.
const failures = new Map<string, { count: number; resetAt: number }>();

function clientKey(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function isLockedOut(key: string) {
  const entry = failures.get(key);
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(key: string) {
  const entry = failures.get(key);
  if (!entry || entry.resetAt <= Date.now()) {
    failures.set(key, { count: 1, resetAt: Date.now() + LOCKOUT_MS });
  } else {
    entry.count += 1;
  }
}

export async function POST(request: NextRequest) {
  const configuredPassword = process.env.APP_ACCESS_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  if (!configuredPassword || !secret || secret.length < 32) {
    return NextResponse.json(
      { error: "App access is not configured. Set APP_ACCESS_PASSWORD and SESSION_SECRET." },
      { status: 503 },
    );
  }

  const key = clientKey(request);
  if (isLockedOut(key)) {
    return NextResponse.json(
      { error: "Too many failed attempts. Try again in 15 minutes." },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter the app password." }, { status: 400 });
  }

  const submitted = Buffer.from(parsed.data.password);
  const expected = Buffer.from(configuredPassword);
  const matches =
    submitted.length === expected.length && timingSafeEqual(submitted, expected);

  if (!matches) {
    recordFailure(key);
    return NextResponse.json({ error: "That password did not match." }, { status: 401 });
  }

  const token = await new SignJWT({ role: "researcher" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("shastra-deep-research")
    .setAudience("shastra-app")
    .setIssuedAt()
    .setExpirationTime(`${SESSION_SECONDS}s`)
    .sign(new TextEncoder().encode(secret));

  failures.delete(key);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
  return response;
}
