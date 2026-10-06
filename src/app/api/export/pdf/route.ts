import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { renderReportPdf } from "@/lib/pdf";
import { blobConfigured, isValidChatId, savePdf } from "@/lib/chat-server";
import { pdfFileName } from "@/lib/research/report";

export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  markdown: z.string().min(1).max(300_000),
  title: z.string().min(1).max(200).default("Research report"),
  subtitle: z.string().max(500).optional(),
  chatId: z.string().optional(),
  messageId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Provide the report markdown and a title." }, { status: 400 });
  }

  try {
    const { pdf, diagrams } = await renderReportPdf(parsed.data);
    if (diagrams.rendered < diagrams.requested) {
      console.warn(`PDF: ${diagrams.requested - diagrams.rendered} of ${diagrams.requested} diagrams did not render.`);
    }
    const name = pdfFileName(parsed.data.title);

    // When the deployment has storage, keep the PDF so it is still there after a reload; the client
    // then previews and downloads it from /api/pdfs/... instead of holding the bytes itself.
    const { chatId, messageId } = parsed.data;
    if (blobConfigured() && chatId && messageId && isValidChatId(chatId) && isValidChatId(messageId)) {
      await savePdf(chatId, messageId, pdf);
      return NextResponse.json({
        stored: true,
        fileName: name,
        url: `/api/pdfs/${chatId}/${messageId}?name=${encodeURIComponent(name)}`,
      });
    }
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "X-Diagrams-Rendered": `${diagrams.rendered}/${diagrams.requested}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("PDF export failed:", error);
    return NextResponse.json({ error: "Could not create the PDF. Is Chromium installed?" }, { status: 500 });
  }
}
