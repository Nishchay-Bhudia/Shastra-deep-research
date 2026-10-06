import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { renderReportPdf } from "@/lib/pdf";

export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  markdown: z.string().min(1).max(300_000),
  title: z.string().min(1).max(200).default("Research report"),
});

function fileName(title: string) {
  const base = title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${base || "shastra-report"}.pdf`;
}

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
    const pdf = await renderReportPdf(parsed.data);
    const name = fileName(parsed.data.title);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("PDF export failed:", error);
    return NextResponse.json({ error: "Could not create the PDF. Is Chromium installed?" }, { status: 500 });
  }
}
