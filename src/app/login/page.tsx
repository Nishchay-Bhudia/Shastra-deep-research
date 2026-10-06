"use client";

import { useState, type FormEvent } from "react";
import { GlassPanel } from "@/components/glass-panel";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(result.error || "Sign in failed.");
        return;
      }
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.assign(next?.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch {
      setError("Could not reach the app. Check the server and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <GlassPanel className="w-full max-w-md p-7 sm:p-9">
        <div className="mb-8 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-2xl border border-white/80 bg-white/60 font-serif text-lg text-amber-900">
            श
          </div>
          <div>
            <p className="font-serif text-xl text-cream-900">Shastra</p>
            <p className="text-[10px] uppercase tracking-[0.18em] text-cream-700">
              Private research workspace
            </p>
          </div>
        </div>
        <h1 className="font-serif text-2xl text-cream-900">Sign in</h1>
        <p className="mt-2 text-sm leading-6 text-cream-700">
          Enter the app password configured by the workspace owner.
        </p>
        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <label className="block text-xs font-medium text-cream-900" htmlFor="password">
            App password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={512}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-2xl border border-cream-400/75 bg-white/70 px-4 py-3 text-sm text-cream-900 outline-none focus:border-cream-700/60"
          />
          {error && (
            <p role="alert" className="text-sm text-red-800">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !password}
            className="w-full rounded-full bg-cream-900 px-5 py-3 text-sm font-medium text-cream-50 transition hover:bg-cream-700 disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Continue"}
          </button>
        </form>
      </GlassPanel>
    </main>
  );
}
