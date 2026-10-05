// SPDX-License-Identifier: MPL-2.0
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { configureApp, HOST } from "./configureApp.js";

const port = Number(process.env.SDLC_CODE_PORT ?? 4317);
const app = configureApp(await NestFactory.create(AppModule));
await app.listen(port, HOST);
console.log(`sdlc-code server on http://${HOST}:${port}`);
