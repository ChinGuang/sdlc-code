// SPDX-License-Identifier: MPL-2.0
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { accessSettings } from "./access.js";
import { configureApp } from "./configureApp.js";

const port = Number(process.env.SDLC_CODE_PORT ?? 4317);
// Refuses to start on the network without an access token (access.ts).
const { host, token } = accessSettings(process.env);
const app = configureApp(await NestFactory.create(AppModule), {
  accessToken: token,
  secureCookie: process.env.SDLC_SECURE_COOKIE === "1",
  webDir: process.env.SDLC_WEB_DIR || null,
});
await app.listen(port, host);
console.log(
  `sdlc-code server on http://${host}:${port}${token ? " (access token required)" : ""}`,
);
