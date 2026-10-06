import type { HTMLAttributes } from "react";

type GlassPanelProps = HTMLAttributes<HTMLDivElement>;

export function GlassPanel({ className = "", ...props }: GlassPanelProps) {
  return (
    <div
      className={`glass-surface rounded-[2rem] ${className}`}
      {...props}
    />
  );
}
