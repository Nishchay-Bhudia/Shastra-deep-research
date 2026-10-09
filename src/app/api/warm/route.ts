import { NextResponse } from "next/server";
import { warmScraper } from "@/lib/scraper/browser";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Starts the browser and signed-in session ahead of a research request. The app calls this when it
 * opens, so a (slow) serverless cold start happens while the user is typing their question.
 */
export async function GET() {
  return NextResponse.json(await warmScraper());
}
