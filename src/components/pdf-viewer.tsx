"use client";

import { useEffect } from "react";

/** Full-screen preview of the generated PDF, with the download one click away. */
export function PdfViewer({
  url,
  fileName,
  onClose,
}: {
  url: string;
  fileName: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${fileName}`}
      className="fixed inset-0 z-50 flex flex-col bg-cream-900/60 p-3 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <div
        className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-hidden rounded-3xl border border-white/70 bg-cream-50 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-cream-300 px-4 py-3">
          <span className="min-w-0 truncate text-sm text-cream-900">{fileName}</span>
          <div className="flex shrink-0 items-center gap-2">
            <a
              href={url}
              download={fileName}
              className="rounded-full bg-cream-900 px-4 py-2 text-xs font-medium text-cream-50 transition hover:bg-cream-700"
            >
              Download PDF
            </a>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-cream-400 px-4 py-2 text-xs text-cream-900 transition hover:bg-white"
            >
              Close
            </button>
          </div>
        </div>
        <iframe title={fileName} src={url} className="min-h-0 w-full flex-1 bg-white" />
      </div>
    </div>
  );
}
