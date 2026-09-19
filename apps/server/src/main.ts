import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

const port = Number(process.env.SDLC_CODE_PORT ?? 4317);
const app = await NestFactory.create(AppModule);
// Bind to loopback only: the server holds API keys and is single-user (grilling Q21).
await app.listen(port, "127.0.0.1");
console.log(`sdlc-code server on http://127.0.0.1:${port}`);
