import { BadRequestException, Body, Controller, Get, Headers, Inject, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { OrdersService, type PlaceInput } from "./orders.service";
import { PaymentsService } from "./payments.service";

@Controller("payments")
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  @Get("status")
  status() {
    return { configured: this.payments.configured() };
  }

  @Post("checkout")
  checkout(@Body() body: PlaceInput) {
    return this.orders.beginCheckout(body);
  }

  @Post("webhook")
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers("x-razorpay-signature") signature?: string) {
    const raw = req.rawBody?.toString("utf8") ?? "";
    if (!this.payments.verifyWebhook(raw, signature)) {
      throw new UnauthorizedException("Payment notice could not be verified.");
    }
    const event = JSON.parse(raw) as { event?: string; payload?: { payment?: { entity?: { order_id?: string; id?: string } } } };
    if (event.event === "payment.captured") {
      const payment = event.payload?.payment?.entity;
      if (!payment?.order_id || !payment.id) throw new BadRequestException("Payment notice was incomplete.");
      await this.orders.capturePayment(payment.order_id, payment.id);
    }
    return { ok: true };
  }
}
