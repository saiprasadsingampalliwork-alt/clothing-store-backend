import "reflect-metadata";
import { json, urlencoded } from "express";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { UPLOAD_DIR } from "./uploads.controller";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.use(
    json({
      limit: "12mb",
      verify: (req, _res, buf) => {
        (req as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: "1mb" }));
  const origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    process.env.APP_URL,
    ...(process.env.CORS_ORIGINS ?? "").split(","),
  ]
    .map((origin) => origin?.trim().replace(/\/$/, ""))
    .filter((origin): origin is string => Boolean(origin));
  app.enableCors({
    origin: [...new Set(origins)],
    allowedHeaders: ["content-type", "authorization", "x-customer-token", "x-order-key"],
  });
  // Behind a load balancer or reverse proxy, set TRUST_PROXY (usually 1) so rate limits see each shopper's own IP.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  app.setGlobalPrefix("v1");
  app.useStaticAssets(UPLOAD_DIR, {
    prefix: "/uploads/",
    index: false,
    dotfiles: "ignore",
    maxAge: "30d",
    immutable: true,
    setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
  });
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`Earthen API listening on http://localhost:${port}/v1`);
}

bootstrap();
