import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { connectVedic, disconnectVedic, hasVedicAccess } from "@/lib/scraper/browser";

export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(512),
});

export async function GET() {
  return NextResponse.json({ connected: hasVedicAccess() });
}

export async function POST(request: NextRequest) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter your vedic.study email and password." }, { status: 400 });
  }
  try {
    await connectVedic(parsed.data.email, parsed.data.password);
    return NextResponse.json({ connected: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not sign in to vedic.study." },
      { status: 401 },
    );
  }
}

export async function DELETE() {
  disconnectVedic();
  return NextResponse.json({ connected: false });
}
