import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { blobConfigured, deleteChat, getChat, isValidChatId, saveChat } from "@/lib/chat-server";

export const runtime = "nodejs";

const bodySchema = z.object({
  title: z.string().min(1).max(200),
  messages: z.array(z.unknown()).max(200),
  pdfs: z.record(z.string(), z.object({ fileName: z.string().max(300) })).optional(),
});

type Context = { params: Promise<{ id: string }> };

async function guard(context: Context) {
  const { id } = await context.params;
  if (!blobConfigured()) {
    return { response: NextResponse.json({ error: "Chat storage is not configured." }, { status: 503 }) };
  }
  if (!isValidChatId(id)) {
    return { response: NextResponse.json({ error: "Invalid chat id." }, { status: 400 }) };
  }
  return { id };
}

export async function GET(_request: NextRequest, context: Context) {
  const checked = await guard(context);
  if ("response" in checked) return checked.response;
  try {
    const chat = await getChat(checked.id);
    return chat ? NextResponse.json(chat) : NextResponse.json({ error: "Not found." }, { status: 404 });
  } catch (error) {
    console.error("Loading chat failed:", error);
    return NextResponse.json({ error: "Could not load the chat." }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, context: Context) {
  const checked = await guard(context);
  if ("response" in checked) return checked.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ error: "Invalid chat." }, { status: 400 });
  try {
    await saveChat({ id: checked.id, title: parsed.data.title, messages: parsed.data.messages, pdfs: parsed.data.pdfs, updatedAt: Date.now() });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Saving chat failed:", error);
    return NextResponse.json({ error: "Could not save the chat." }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  const checked = await guard(context);
  if ("response" in checked) return checked.response;
  try {
    await deleteChat(checked.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Deleting chat failed:", error);
    return NextResponse.json({ error: "Could not delete the chat." }, { status: 500 });
  }
}
