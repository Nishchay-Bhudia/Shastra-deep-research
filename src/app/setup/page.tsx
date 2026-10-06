import Link from "next/link";
import { GlassPanel } from "@/components/glass-panel";

export default function SetupPage() {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <GlassPanel className="w-full max-w-2xl p-7 sm:p-9">
        <p className="text-xs uppercase tracking-[0.19em] text-cream-700">
          First-time setup
        </p>
        <h1 className="mt-2 font-serif text-3xl text-cream-900">
          Configure the server secrets
        </h1>
        <p className="mt-3 text-sm leading-6 text-cream-700">
          Shastra is private by default. Add the required values to your deployment
          environment (or copy <code>.env.example</code> to <code>.env.local</code>
          for local development), then restart the app.
        </p>
        <div className="my-6 space-y-3 rounded-2xl border border-cream-300 bg-white/45 p-5 text-sm">
          <p><code>MISTRAL_API_KEY</code> — server-side model access.</p>
          <p><code>APP_ACCESS_PASSWORD</code> — the private app sign-in password.</p>
          <p><code>SESSION_SECRET</code> — a random signing secret, at least 32 characters.</p>
        </div>
        <p className="text-xs leading-5 text-cream-700">
          Do not put secrets in source code, commit them, or send them in chat.
          The research API remains protected until the access password and session
          secret are configured.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-full border border-cream-400 bg-white/55 px-4 py-2 text-sm text-cream-900 hover:bg-white"
        >
          Go to sign in
        </Link>
      </GlassPanel>
    </main>
  );
}
