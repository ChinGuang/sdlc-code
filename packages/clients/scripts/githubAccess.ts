/**
 * Checks the GitHub PAT against a Target Repo. Run:
 *   pnpm --filter @sdlc-code/clients github:access ChinGuang/sdlc-code-demo-todo
 */
import { RestGitHubClient, type GitHubClient } from "../src/index.js";
import { requireEnv } from "./requireEnv.js";

const [owner, name] = (process.argv[2] ?? "").split("/");
if (!owner || !name) {
  console.error("Usage: github:access <owner>/<repo>");
  process.exit(1);
}

const client: GitHubClient = new RestGitHubClient({
  token: requireEnv("GITHUB_TOKEN"),
});
const repo = await client.getRepo({ owner, name });
console.log(JSON.stringify(repo, null, 2));
if (!repo.canPush) {
  console.error(
    "Your account cannot push here. Also make sure the fine-grained PAT has Contents and Pull requests (read and write): GitHub only reports the account role.",
  );
  process.exitCode = 1;
}
