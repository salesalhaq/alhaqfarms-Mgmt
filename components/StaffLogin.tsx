"use client";

import { ArrowRight, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { BrandLockup } from "@/components/BrandLockup";
import { useStaffAuth } from "@/components/StaffAuthProvider";

export function StaffLogin() {
  const router = useRouter();
  const { signIn, signInWithUsername, staff, loading, error: authError } = useStaffAuth();
  const [method, setMethod] = useState<"email" | "username-password" | "pin">("username-password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && staff) router.replace("/orders");
  }, [loading, router, staff]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (method === "email") {
        await signIn(email.trim(), password);
      } else if (method === "username-password") {
        await signInWithUsername(username.trim(), "password", password);
      } else {
        await signInWithUsername(username.trim(), "pin", pin);
      }
      router.replace("/orders");
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-screen">
      <section className="login-card">
        <BrandLockup />
        <p className="eyebrow">Staff portal</p>
        <h1>Welcome back</h1>
        <p className="muted">Use your shared staff account to access your assigned branch.</p>
        {(error || authError) && <div className="notice" role="alert">{error || authError}</div>}
        {loading && !authError ? (
          <div className="loading"><LoaderCircle size={18} className="spin" /> Checking your staff account…</div>
        ) : (
          <>
            <div className="login-methods" role="tablist" aria-label="Sign-in method">
              <button
                aria-selected={method === "username-password"}
                className={`login-method ${method === "username-password" ? "active" : ""}`}
                onClick={() => setMethod("username-password")}
                role="tab"
                type="button"
              >
                Username & password
              </button>
              <button
                aria-selected={method === "pin"}
                className={`login-method ${method === "pin" ? "active" : ""}`}
                onClick={() => setMethod("pin")}
                role="tab"
                type="button"
              >
                Username & PIN
              </button>
              <button
                aria-selected={method === "email"}
                className={`login-method ${method === "email" ? "active" : ""}`}
                onClick={() => setMethod("email")}
                role="tab"
                type="button"
              >
                Email login
              </button>
            </div>
            <form onSubmit={submit}>
              {method === "email" ? (
                <>
                  <label className="field">
                    <span>Staff email</span>
                    <input
                      autoComplete="username"
                      autoFocus
                      required
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Password</span>
                    <input
                      autoComplete="current-password"
                      required
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="field">
                    <span>Staff username</span>
                    <input
                      autoComplete="username"
                      autoFocus
                      required
                      type="text"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>{method === "pin" ? "PIN" : "Password"}</span>
                    {method === "pin" ? (
                      <input
                        autoComplete="current-password"
                        inputMode="numeric"
                        maxLength={8}
                        minLength={4}
                        pattern="[0-9]{4,8}"
                        required
                        type="password"
                        value={pin}
                        onChange={(event) => setPin(event.target.value)}
                      />
                    ) : (
                      <input
                        autoComplete="current-password"
                        minLength={10}
                        required
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    )}
                  </label>
                </>
              )}
              <button className="button full" disabled={submitting} type="submit">
                {submitting ? <LoaderCircle size={16} className="spin" /> : <>Sign in <ArrowRight size={16} /></>}
              </button>
            </form>
            <Link className="button secondary full" href="/enroll">
              New staff? Enroll with invite code <ArrowRight size={16} />
            </Link>
          </>
        )}
        <p className="login-footnote">
          Use the same username, password, and optional PIN on Windows and web.
        </p>
      </section>
    </main>
  );
}
