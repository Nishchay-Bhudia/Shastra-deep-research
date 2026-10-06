import { get } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import { blobConfigured, isValidChatId, pdfPath } from "@/lib/chat-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ chatId: string; messageId: string }> };

/** Streams a stored report PDF (private Blob) to the signed-in user, inline so it can be previewed. */
export async function GET(request: NextRequest, context: Context) {
  const { chatId, messageId } = await context.params;
  if (!blobConfigured() || !isValidChatId(chatId) || !isValidChatId(messageId)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  try {
    const result = await get(pdfPath(chatId, messageId), { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const name = (request.nextUrl.searchParams.get("name") || "report.pdf").replace(/[^\w.\-\p{L}\p{M}\p{N}]+/gu, "-");
    return new NextResponse(result.stream, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    console.error("Reading PDF failed:", error);
    return NextResponse.json({ error: "Could not load the PDF." }, { status: 500 });
  }
}
