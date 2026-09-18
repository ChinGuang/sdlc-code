/** Reads a required environment variable or exits with a clear message. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name} in sdlc-code/.env (see .env.example)`);
    process.exit(1);
  }
  return value;
}
