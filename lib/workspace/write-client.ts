export interface WorkspaceWriteOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/**
 * Creates a client-side idempotency key. `crypto.randomUUID` requires a secure
 * context, so a small fallback keeps the helper usable on plain-HTTP staging.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorMessage(result: unknown): string {
  if (result && typeof result === "object" && "error" in result) {
    const message = (result as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "The change could not be saved. Please try again.";
}

/**
 * Sends one write action to a workspace API route. Every call carries an
 * idempotency key so retries of the same submit cannot create duplicates.
 */
export async function postWorkspaceAction<T>(
  url: string,
  payload: Record<string, unknown>,
  options: WorkspaceWriteOptions = {},
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify({
      ...payload,
      idempotencyKey: options.idempotencyKey || newIdempotencyKey(),
    }),
    signal: options.signal,
  });

  let result: unknown = null;
  try {
    result = await response.json();
  } catch {
    result = null;
  }

  if (!response.ok) throw new Error(errorMessage(result));
  return result as T;
}
