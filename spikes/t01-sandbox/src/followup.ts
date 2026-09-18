/** Follow-up measurements for the T01 doc: public images and polling overhead. */
import { NebiusSandboxClient, type SandboxClient } from "./sandboxClient.js";
const client: SandboxClient = new NebiusSandboxClient({ token: process.env.NEBIUS_API_KEY!, project: process.env.NEBIUS_AI_PROJECT!, baseUrl: process.env.NEBIUS_SANDBOX_URL });
const all = (await client.listImages()).images.map((i) => i.tag).filter(Boolean);
console.log("public/our tags:", all.length, JSON.stringify(all.filter((t) => /node|python|ubuntu|debian|bun|deno/i.test(String(t)))));
const node = (await client.listImages("sdlc-code/node")).images[0]!.uuid;
for (const pollMs of [1000, 250, 100]) {
  const walls: number[] = []; const durs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const r = await client.run({ image: node, command: "node -e 'console.log(1)'", shell: true, disposable: true, timeout: 30 }, { pollMs });
    walls.push(Date.now() - t); durs.push(Math.round((r.durationSeconds ?? 0) * 1000));
  }
  console.log(`pollMs=${pollMs} wall ms`, walls, "server duration ms", durs);
}
