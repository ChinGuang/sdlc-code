/** Replaces every occurrence of each non-empty secret with "[redacted]". */
export function redactSecrets(text: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret !== "")
    .reduce((out, secret) => out.replaceAll(secret, "[redacted]"), text);
}
