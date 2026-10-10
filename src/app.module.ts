import { Module } from "@nestjs/common";
import { CatalogController } from "./catalog.controller";
import { CustomersController } from "./customers.controller";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { PrismaService } from "./prisma.service";
import { StudioController } from "./studio.controller";

@Module({
  controllers: [CatalogController, CustomersController, OrdersController, StudioController],
  providers: [PrismaService, OrdersService],
})
export class AppModule {}
