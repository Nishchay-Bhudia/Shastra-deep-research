import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shastra — Vedic Deep Research",
  description:
    "A source-grounded research workspace for Vedic texts in English, Sanskrit, and Gujarati.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="font-sans">{children}</body>
    </html>
  );
}
