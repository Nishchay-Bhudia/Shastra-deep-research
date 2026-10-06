"use client";

import { useEffect, useState } from "react";
import { wordsFor, type Phase } from "@/lib/research/thinking-words";

/** A status word that changes every couple of seconds while the agent works. */
export function ThinkingWord({ phase }: { phase: Phase }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setTick(Math.floor(Math.random() * 100));
    const timer = window.setInterval(() => setTick((value) => value + 1), 2400);
    return () => window.clearInterval(timer);
  }, [phase]);

  const words = wordsFor(phase);
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-600" />
      <span key={tick} className="animate-pulse">
        {words[tick % words.length]}…
      </span>
    </span>
  );
}
