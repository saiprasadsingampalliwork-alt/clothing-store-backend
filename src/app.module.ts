import { Module } from "@nestjs/common";
import { AudiencesController } from "./audiences.controller";
import { CatalogController } from "./catalog.controller";
import { DeliveryController } from "./delivery.controller";
import { FabricsController } from "./fabrics.controller";
import { StylesController } from "./styles.controller";
import { CustomersController } from "./customers.controller";
import { OrdersController } from "./orders.controller";
import { MailService } from "./mail.service";
import { NudgesService } from "./nudges.service";
import { WhatsAppController } from "./whatsapp.controller";
import { WhatsAppService } from "./whatsapp.service";
import { OrdersService } from "./orders.service";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PrismaService } from "./prisma.service";
import { ReportsController } from "./reports.controller";
import { StudioController } from "./studio.controller";
import { UploadsController } from "./uploads.controller";

@Module({
  controllers: [AudiencesController, CatalogController, DeliveryController, FabricsController, CustomersController, OrdersController, PaymentsController, ReportsController, StudioController, StylesController, UploadsController, WhatsAppController],
  providers: [PrismaService, MailService, WhatsAppService, NudgesService, PaymentsService, OrdersService],
})
export class AppModule {}
