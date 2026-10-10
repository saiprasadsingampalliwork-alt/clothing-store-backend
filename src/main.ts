import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
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
