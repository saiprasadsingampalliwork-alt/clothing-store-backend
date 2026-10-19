import { Module } from "@nestjs/common";
import { CatalogController } from "./catalog.controller";
import { CustomersController } from "./customers.controller";
import { OrdersController } from "./orders.controller";
import { MailService } from "./mail.service";
import { NudgesService } from "./nudges.service";
import { WhatsAppService } from "./whatsapp.service";
import { OrdersService } from "./orders.service";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PrismaService } from "./prisma.service";
import { ReportsController } from "./reports.controller";
import { StudioController } from "./studio.controller";
import { UploadsController } from "./uploads.controller";

@Module({
  controllers: [CatalogController, CustomersController, OrdersController, PaymentsController, ReportsController, StudioController, UploadsController],
  providers: [PrismaService, MailService, WhatsAppService, NudgesService, PaymentsService, OrdersService],
})
export class AppModule {}
