"use client";

import { useCallback, useState } from "react";

export interface WorkspaceActionState {
  pending: boolean;
  error: string | null;
  message: string | null;
  setError: (message: string | null) => void;
  setMessage: (message: string | null) => void;
  clearFeedback: () => void;
  run: <T>(action: () => Promise<T>) => Promise<T | null>;
}

/**
 * Shared submit state for workspace write dialogs. Keeps the pending flag,
 * error text, and success text consistent across every module.
 */
export function useWorkspaceAction(onSuccess?: () => void | Promise<void>): WorkspaceActionState {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const clearFeedback = useCallback(() => {
    setError(null);
    setMessage(null);
  }, []);

  const run = useCallback(async function runAction<T>(action: () => Promise<T>): Promise<T | null> {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      if (onSuccess) await onSuccess();
      return result;
    } catch (actionError) {
      setError(actionError instanceof Error
        ? actionError.message
        : "The change could not be saved. Please try again.");
      return null;
    } finally {
      setPending(false);
    }
  }, [onSuccess]);

  return { pending, error, message, setError, setMessage, clearFeedback, run };
}
