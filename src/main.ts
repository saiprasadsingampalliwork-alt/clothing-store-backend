import "reflect-metadata";
import { json, urlencoded } from "express";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";

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
  app.enableCors({
    origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
    allowedHeaders: ["content-type", "authorization", "x-customer-token"],
  });
  app.setGlobalPrefix("v1");
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`Earthen API listening on http://localhost:${port}/v1`);
}

bootstrap();
