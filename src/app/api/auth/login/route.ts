import { SignJWT } from "jose";
import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({ password: z.string().min(1).max(512) });
const COOKIE_NAME = "shastra_session";
const SESSION_SECONDS = 60 * 60 * 12;

export async function POST(request: NextRequest) {
  const configuredPassword = process.env.APP_ACCESS_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  if (!configuredPassword || !secret || secret.length < 32) {
    return NextResponse.json(
      { error: "App access is not configured. Set APP_ACCESS_PASSWORD and SESSION_SECRET." },
      { status: 503 },
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
    return NextResponse.json({ error: "That password did not match." }, { status: 401 });
  }

  const token = await new SignJWT({ role: "researcher" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("shastra-deep-research")
    .setAudience("shastra-app")
    .setIssuedAt()
    .setExpirationTime(`${SESSION_SECONDS}s`)
    .sign(new TextEncoder().encode(secret));

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
