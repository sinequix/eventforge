import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowUpRight, Check, Mail, ShieldCheck } from "lucide-react";
import { captureEvent } from "./analytics";

type SubmissionState = "idle" | "submitting" | "success" | "error";

const WAITLIST_API_URL = import.meta.env.VITE_WAITLIST_API_URL?.trim() || "/v1/waitlist";

export function WaitlistForm({ source, idPrefix }: { source: string; idPrefix: string }) {
  const [state, setState] = useState<SubmissionState>("idle");
  const [message, setMessage] = useState("");
  const emailId = `${idPrefix}-email`;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const email = String(form.get("email") ?? "").trim();
    const consent = form.get("consent") === "on";
    const website = String(form.get("website") ?? "");
    captureEvent("waitlist_submit_started", { source });
    setState("submitting");
    setMessage("");
    try {
      const response = await fetch(WAITLIST_API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, consent, website, source }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        accepted?: boolean;
        detail?: string;
        alreadyRegistered?: boolean;
      };
      if (!response.ok || !body.accepted)
        throw new Error(body.detail || "The waitlist is unavailable.");
      setState("success");
      setMessage(
        "You are on the list. We will send the next useful update, not a noisy newsletter.",
      );
      captureEvent("waitlist_submitted");
      formElement.reset();
    } catch (error) {
      setState("error");
      setMessage(
        error instanceof Error ? error.message : "The waitlist is unavailable. Try again soon.",
      );
      captureEvent("waitlist_submit_failed");
    }
  };

  return (
    <form className="ef-waitlist-form" onSubmit={submit} noValidate>
      <label htmlFor={emailId}>Work email</label>
      <input
        id={emailId}
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@company.com"
        required
        maxLength={254}
        disabled={state === "submitting"}
      />
      <label className="ef-waitlist-consent">
        <input name="consent" type="checkbox" required disabled={state === "submitting"} />
        <span>I want launch updates when hosted access opens for new teams.</span>
      </label>
      <label className="ef-honeypot" aria-hidden="true">
        Website
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>
      <button type="submit" disabled={state === "submitting"}>
        {state === "submitting" ? "Joining…" : "Join the waitlist"}
        <ArrowUpRight size={16} />
      </button>
      <p className={`ef-waitlist-message ef-waitlist-message--${state}`} role="status">
        {message}
      </p>
    </form>
  );
}

export default function WaitlistPage() {
  return (
    <main className="ef-waitlist-page">
      <div className="ef-grain" aria-hidden="true" />
      <header className="ef-waitlist-header">
        <a className="ef-brand" href="/" aria-label="Return to EventForge home">
          <img className="ef-mark" src="/eventforge-mark.svg" alt="" aria-hidden="true" />
          <span>EventForge</span>
        </a>
        <a className="ef-waitlist-back" href="/">
          <ArrowLeft size={15} /> Back home
        </a>
      </header>
      <section className="ef-waitlist-card" aria-labelledby="waitlist-title">
        <div className="ef-eyebrow">
          <Mail size={14} /> Waitlist
        </div>
        <h1 id="waitlist-title">
          Bring your event stream
          <br />
          <em>under one roof.</em>
        </h1>
        <p>
          Sign-in is live for invited workspaces. New accounts are closed. Leave a work email and we
          will send the next useful update, not a noisy newsletter.
        </p>
        <WaitlistForm idPrefix="waitlist" source="direct" />
        <div className="ef-waitlist-trust">
          <ShieldCheck size={17} /> No passwords. No payloads. Unsubscribe any time.
        </div>
        <a
          className="ef-waitlist-local"
          href="https://github.com/tebayoso/eventforge"
          target="_blank"
          rel="noreferrer"
        >
          Prefer local-first? Install EventForge now <Check size={15} />
        </a>
      </section>
    </main>
  );
}
