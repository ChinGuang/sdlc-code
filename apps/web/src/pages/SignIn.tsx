// SPDX-License-Identifier: MPL-2.0
import { useState, type FormEvent } from "react";
import type { RunsApi } from "../api/client.js";

/**
 * Shown when the server is on a network and asks for its access token (S2).
 * The token goes to the server once; what the browser keeps is a cookie that
 * scripts cannot read.
 */
export function SignIn({
  api,
  onSignedIn,
}: {
  api: RunsApi;
  onSignedIn: () => void;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setError(null);
    try {
      await api.signIn(token);
      onSignedIn();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="card" aria-label="Sign in" onSubmit={submit}>
      <h2>Sign in</h2>
      <p className="muted small">
        This server is on a network, so it asks for its access token.
      </p>
      <label className="field">
        Access token
        <input
          className="mono"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button
        type="submit"
        className="button primary"
        disabled={sending || token === ""}
      >
        {sending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
