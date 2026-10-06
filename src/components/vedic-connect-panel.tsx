"use client";

import { useState, type FormEvent } from "react";
import { GlassPanel } from "@/components/glass-panel";

export function VedicConnectPanel({ onConnected }: { onConnected: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/vedic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(result.error || "Could not sign in to vedic.study.");
        return;
      }
      setPassword("");
      onConnected();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <GlassPanel className="w-full max-w-md p-7 sm:p-9">
        <p className="text-xs uppercase tracking-[0.19em] text-cream-700">One more step</p>
        <h1 className="mt-2 font-serif text-2xl text-cream-900">Connect vedic.study</h1>
        <p className="mt-2 text-sm leading-6 text-cream-700">
          Sign in with the email and password of your invited vedic.study account. Shastra
          signs in on its own to research for you. Your password is used once to sign in and
          is not stored; only the signed-in session is kept in the server&apos;s memory.
        </p>
        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-cream-900" htmlFor="vs-email">
              vedic.study email
            </label>
            <input
              id="vs-email"
              type="email"
              autoComplete="username"
              required
              maxLength={320}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1.5 w-full rounded-2xl border border-cream-400/75 bg-white/70 px-4 py-3 text-sm text-cream-900 outline-none focus:border-cream-700/60"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-cream-900" htmlFor="vs-password">
              vedic.study password
            </label>
            <input
              id="vs-password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={512}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1.5 w-full rounded-2xl border border-cream-400/75 bg-white/70 px-4 py-3 text-sm text-cream-900 outline-none focus:border-cream-700/60"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm leading-5 text-red-800">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !email || !password}
            className="w-full rounded-full bg-cream-900 px-5 py-3 text-sm font-medium text-cream-50 transition hover:bg-cream-700 disabled:opacity-50"
          >
            {busy ? "Signing in to vedic.study…" : "Connect"}
          </button>
          {busy && (
            <p className="text-center text-xs text-cream-700">This can take up to 30 seconds.</p>
          )}
        </form>
      </GlassPanel>
    </main>
  );
}
