import { BadRequestException, Body, Controller, Get, Headers, Inject, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { OrdersService, type PlaceInput } from "./orders.service";
import { PaymentsService } from "./payments.service";
import { RateLimit } from "./rate-limit";

type WebhookEvent = {
  event?: string;
  payload?: {
    payment?: { entity?: { order_id?: string; id?: string } };
    refund?: { entity?: { id?: string; payment_id?: string } };
  };
};

// Starting a payment creates a Razorpay order, so each visitor gets a few per ten minutes.
const starts = new RateLimit(10, 10 * 60 * 1000, "Too many payment attempts. Wait a few minutes and try again.");

@Controller("payments")
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  @Get("status")
  status() {
    return { configured: this.payments.configured(), mode: this.payments.mode() };
  }

  @Post("checkout")
  checkout(@Req() req: Request, @Body() body: PlaceInput) {
    starts.take(req.ip || "unknown");
    return this.orders.beginCheckout(body);
  }

  /**
   * Razorpay retries any webhook that does not get a 2xx. Once the signature checks out, problems are
   * logged and recorded rather than returned, so a payment that cannot become an order is refunded, not retried.
   */
  @Post("webhook")
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers("x-razorpay-signature") signature?: string) {
    const raw = req.rawBody?.toString("utf8") ?? "";
    if (!this.payments.verifyWebhook(raw, signature)) {
      throw new UnauthorizedException("Payment notice could not be verified.");
    }
    let event: WebhookEvent;
    try {
      event = JSON.parse(raw) as WebhookEvent;
    } catch {
      throw new BadRequestException("Payment notice was not readable.");
    }
    try {
      if (event.event === "payment.captured") {
        const payment = event.payload?.payment?.entity;
        if (payment?.order_id && payment.id) await this.orders.capturePayment(payment.order_id, payment.id);
      }
      if (event.event === "refund.processed" || event.event === "refund.failed") {
        const refund = event.payload?.refund?.entity;
        if (refund?.id && refund.payment_id) await this.orders.recordRefund(refund.id, refund.payment_id, event.event === "refund.processed" ? "refunded" : "failed");
      }
    } catch (error) {
      console.error(`[pay] Webhook ${event.event} could not be handled.`, error);
    }
    return { ok: true };
  }
}
