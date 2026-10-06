import { NextResponse } from "next/server";
import { blobConfigured, listChats } from "@/lib/chat-server";

export const runtime = "nodejs";

export async function GET() {
  if (!blobConfigured()) {
    return NextResponse.json({ error: "Chat storage is not configured." }, { status: 503 });
  }
  try {
    return NextResponse.json({ chats: await listChats() });
  } catch (error) {
    console.error("Listing chats failed:", error);
    return NextResponse.json({ error: "Could not load chats." }, { status: 500 });
  }
}
