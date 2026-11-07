"use client";

import { ArrowRight, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { useStaffAuth } from "@/components/StaffAuthProvider";

export function StaffEnrollment() {
  const router = useRouter();
  const { enrollWithInvitation } = useStaffAuth();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [pin, setPin] = useState("");
  const [pinConfirmation, setPinConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (password !== passwordConfirmation) {
      setError("The password entries do not match.");
      return;
    }
    if (pin !== pinConfirmation) {
      setError("The PIN entries do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await enrollWithInvitation(code.trim(), password, pin);
      router.replace("/orders");
    } catch (enrollError) {
      setError(enrollError instanceof Error ? enrollError.message : "Enrollment failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-screen">
      <section className="login-card">
        <div className="brand-mark" aria-label="Al Haq Farms">AH</div>
        <p className="eyebrow">Staff enrollment</p>
        <h1>Set up your account</h1>
        <p className="muted">Use the invite code from your administrator. Choose the same password and PIN you use on Windows.</p>
        {error && <div className="notice" role="alert">{error}</div>}
        <form onSubmit={submit}>
          <label className="field">
            <span>HQ invite code</span>
            <input
              autoComplete="one-time-code"
              autoFocus
              maxLength={32}
              minLength={32}
              pattern="[0-9a-fA-F]{32}"
              required
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value.trim())}
            />
          </label>
          <label className="field">
            <span>Password (10–200 characters)</span>
            <input
              autoComplete="new-password"
              maxLength={200}
              minLength={10}
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Confirm password</span>
            <input
              autoComplete="new-password"
              maxLength={200}
              minLength={10}
              required
              type="password"
              value={passwordConfirmation}
              onChange={(event) => setPasswordConfirmation(event.target.value)}
            />
          </label>
          <label className="field">
            <span>PIN (optional, 4–8 digits)</span>
            <input
              autoComplete="new-password"
              inputMode="numeric"
              maxLength={8}
              minLength={4}
              pattern="[0-9]{4,8}"
              type="password"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
            />
          </label>
          {pin && (
            <label className="field">
              <span>Confirm PIN</span>
              <input
                autoComplete="new-password"
                inputMode="numeric"
                maxLength={8}
                minLength={4}
                pattern="[0-9]{4,8}"
                required
                type="password"
                value={pinConfirmation}
                onChange={(event) => setPinConfirmation(event.target.value)}
              />
            </label>
          )}
          <button className="button full" disabled={submitting} type="submit">
            {submitting ? <LoaderCircle size={16} className="spin" /> : <>Create account <ArrowRight size={16} /></>}
          </button>
        </form>
        <p className="login-footnote">
          This invite can be used once for web setup and once on the assigned Windows device. Both setups must use matching credentials.
          {" "}<Link href="/login">Already enrolled? Sign in</Link>
        </p>
      </section>
    </main>
  );
}
