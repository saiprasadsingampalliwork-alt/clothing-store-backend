import { randomBytes } from "crypto";
import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { MailService, type MailItem, type MailOrder, type OrderMail } from "./mail.service";
import { PaymentNotConfirmedException, PaymentsService } from "./payments.service";
import { WhatsAppService } from "./whatsapp.service";
import { evaluateCoupon, livePrice, shippingFee, type CouponRecord, type ShippingRules } from "./pricing";
import { isOnSale } from "./audiences";
import { checkDeliveryAddress, cleanMobile } from "./delivery";

type ItemInput = { slug: string; color: string; size: string; quantity: number };

export type PlaceInput = {
  email: string;
  phone: string;
  address: Record<string, unknown>;
  delivery: "standard" | "express";
  payment: "upi" | "card" | "netbanking" | "cod";
  coupon?: string;
  items: ItemInput[];
  razorpay?: { orderId: string; paymentId: string; signature?: string };
};

const defaultSettings: ShippingRules & Record<string, unknown> = {
  freeShippingAt: 1999,
  standardShipping: 99,
  expressShipping: 149,
  deliveryEstimate: "3–5 days",
  codEnabled: true,
  codFee: 40,
  codMax: 10000,
  returnWindowDays: 7,
  refundMethod: "Original payment",
  exchanges: true,
  businessName: "Earthen",
  gstin: "",
  pricesIncludeGst: true,
  announcementEnabled: true,
  announcementText: "",
  announcementHref: "",
  saleEnabled: false,
  saleName: "",
  salePercent: 0,
  saleStart: "",
  saleEnd: "",
};

/** Where an order may go next. Cancelled and Returned are final; returns go through decideReturn. */
export const NEXT_STATUS: Record<string, string[]> = {
  Confirmed: ["Packed", "Shipped", "Cancelled"],
  Packed: ["Shipped", "Cancelled"],
  Shipped: ["Out for delivery", "Delivered"],
  "Out for delivery": ["Delivered"],
  Delivered: [],
  "Return requested": [],
  Cancelled: [],
  Returned: [],
};

type PaymentStatus = "cod" | "paid" | "demo" | "free";
type Prepared = PlaceInput & { existingOrderId?: string; paymentStatus: PaymentStatus; amountPaise?: number };

@Injectable()
export class OrdersService implements OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(WhatsAppService) private readonly whatsapp: WhatsAppService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  // Gives older orders an access key and a payment status, once.
  async onModuleInit() {
    await this.prisma.$executeRaw`UPDATE "Order" SET "accessKey" = md5(random()::text || id) WHERE "accessKey" = ''`;
    await this.prisma.$executeRaw`UPDATE "Order" SET "paymentStatus" = CASE WHEN payment = 'cod' THEN 'cod' WHEN "razorpayPaymentId" IS NOT NULL THEN 'paid' ELSE 'demo' END WHERE "paymentStatus" = ''`;
  }

  async settings(): Promise<ShippingRules & Record<string, unknown>> {
    const row = await this.prisma.setting.findUnique({ where: { id: "store" } });
    return { ...defaultSettings, ...((row?.data as object) ?? {}) };
  }

  async beginCheckout(input: PlaceInput) {
    if (input.payment === "cod") throw new BadRequestException("Cash on delivery does not use the payment gateway.");
    const email = input.email?.trim().toLowerCase();
    if (email) {
      const customer = await this.prisma.customer.findUnique({ where: { email } });
      if (customer?.blocked) throw new BadRequestException("This account is blocked and cannot place an order.");
    }
    this.requireOnlinePayments();
    const quoted = await this.quote({ ...input, email: email || input.email });
    // Demo mode records the order without a charge; a ₹0 order has nothing to charge.
    if (this.payments.mode() === "demo") return { configured: false as const, mode: "demo" as const };
    if (quoted.total < 1) return { configured: false as const, mode: "live" as const };
    // Checkouts that were started but never paid are cleared after a day.
    await this.prisma.paymentCheckout.deleteMany({ where: { usedAt: null, failedReason: null, createdAt: { lt: new Date(Date.now() - 86400000) } } });
    const gateway = await this.payments.createOrder(quoted.total * 100, `earthen-${Date.now()}`);
    await this.prisma.paymentCheckout.create({
      data: {
        razorpayOrderId: gateway.id,
        amountPaise: quoted.total * 100,
        payload: { ...input, razorpay: undefined } as Prisma.InputJsonValue,
      },
    });
    return {
      configured: true as const,
      keyId: this.payments.keyId(),
      razorpayOrderId: gateway.id,
      amount: quoted.total * 100,
      currency: "INR" as const,
    };
  }

  /** Called by the payment.captured webhook. Creates the order if the browser did not, or refunds if it cannot. */
  async capturePayment(razorpayOrderId: string, paymentId: string) {
    const checkout = await this.prisma.paymentCheckout.findUnique({ where: { razorpayOrderId } });
    if (!checkout || checkout.usedAt || checkout.failedReason) return null;
    try {
      return await this.place({ ...(checkout.payload as PlaceInput), razorpay: { orderId: razorpayOrderId, paymentId } }, { trustedPayment: true });
    } catch (error) {
      console.error(`[pay] Captured payment ${paymentId} did not become an order.`, error);
      return null;
    }
  }

  /** Records a Razorpay refund webhook on the order or the failed checkout it belongs to. */
  async recordRefund(refundId: string, paymentId: string, status: "refunded" | "failed") {
    const note = status === "refunded" ? "Refunded by Razorpay." : "Razorpay could not complete the refund. Retry it from the order.";
    const orders = await this.prisma.order.updateMany({ where: { razorpayPaymentId: paymentId }, data: { refundStatus: status, refundId, refundNote: note } });
    if (orders.count === 0) await this.prisma.paymentCheckout.updateMany({ where: { paymentId }, data: { refundStatus: status, refundId } });
  }

  async place(input: PlaceInput, options?: { trustedPayment?: boolean }) {
    const prepared = await this.paidInput(input, options?.trustedPayment);
    if (prepared.existingOrderId) {
      const existing = await this.prisma.order.findUnique({ where: { id: prepared.existingOrderId } });
      if (existing) return this.present(existing);
    }
    try {
      return await this.createOrder(prepared, options?.trustedPayment);
    } catch (error) {
      // Only a payment we know is good, for an order that cannot be made, is refunded.
      if (!prepared.razorpay || !(error instanceof BadRequestException) || error instanceof PaymentNotConfirmedException) throw error;
      // Another request (the webhook or a retry) may have created the order for this payment.
      const checkout = await this.prisma.paymentCheckout.findUnique({ where: { razorpayOrderId: prepared.razorpay.orderId } });
      if (checkout?.orderId) {
        const existing = await this.prisma.order.findUnique({ where: { id: checkout.orderId } });
        if (existing) return this.present(existing);
      }
      // The customer paid, but the order cannot be made (stock sold out, price or coupon changed). Give the money back.
      const reason = error.message;
      const refund = await this.failPaidCheckout(prepared.razorpay.orderId, prepared.razorpay.paymentId, reason);
      const amount = `₹${((checkout?.amountPaise ?? 0) / 100).toLocaleString("en-IN")}`;
      throw new BadRequestException(
        refund === "failed"
          ? `${reason} We could not place your order, and your payment of ${amount} needs a refund. The studio has been told and will refund it.`
          : `${reason} We could not place your order, so your payment of ${amount} has been refunded. It reaches your account in 5–7 working days.`,
      );
    }
  }

  private async createOrder(prepared: Prepared, trustedPayment?: boolean) {
    const email = prepared.email.trim().toLowerCase();
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (customer?.blocked) throw new BadRequestException("This account is blocked and cannot place an order.");
    const quoted = await this.quote({ ...prepared, email });
    if (prepared.razorpay) {
      if (quoted.total * 100 !== prepared.amountPaise) throw new BadRequestException("The price of your bag changed while you were paying.");
      // The webhook only fires for captured payments; the browser's proof is checked with Razorpay.
      if (!trustedPayment) await this.payments.ensureCaptured(prepared.razorpay.paymentId, prepared.razorpay.orderId, quoted.total * 100);
    }
    // A ₹0 order skips payment; if the total rose in the meantime (a coupon ran out), it needs paying after all.
    if (prepared.paymentStatus === "free" && quoted.total > 0) throw new BadRequestException("Your total changed. Place the order again to pay.");
    const paymentStatus: PaymentStatus = prepared.paymentStatus;

    const order = await this.prisma.$transaction(async (tx) => {
      // Lock each product row (in a fixed order, so two orders cannot deadlock) so simultaneous orders cannot oversell.
      for (const slug of [...new Set(quoted.items.map((item) => item.slug))].sort()) {
        await tx.$queryRaw`SELECT slug FROM "Product" WHERE slug = ${slug} FOR UPDATE`;
      }
      for (const item of quoted.items) {
        const product = await tx.product.findUnique({ where: { slug: item.slug } });
        const stock = { ...(product!.stock as Record<string, number>) };
        if ((stock[item.stockKey] ?? 0) < item.quantity) {
          throw new BadRequestException(`${item.name} in ${item.color}, size ${item.size} is no longer available.`);
        }
        stock[item.stockKey] = (stock[item.stockKey] ?? 0) - item.quantity;
        await tx.product.update({ where: { slug: item.slug }, data: { stock } });
      }
      const sequence = await tx.sequence.update({ where: { id: "order" }, data: { value: { increment: 1 } } });
      const created = await tx.order.create({
        data: {
          id: `order-${Date.now()}-${randomBytes(3).toString("hex")}`,
          number: `EA-${sequence.value}`,
          email,
          phone: quoted.phone,
          address: quoted.address as Prisma.InputJsonValue,
          items: quoted.items.map(({ stockKey: _stockKey, ...item }) => item) as Prisma.InputJsonValue,
          delivery: prepared.delivery,
          payment: prepared.payment,
          paymentStatus,
          accessKey: randomBytes(16).toString("hex"),
          subtotal: quoted.subtotal,
          discount: quoted.discount,
          shipping: quoted.shipping,
          codFee: quoted.codFee,
          total: quoted.total,
          coupon: quoted.couponCode,
          status: "Confirmed",
          timeline: [{ status: "Confirmed", date: new Date().toISOString() }],
          trackingUrl: "https://www.shiprocket.in/",
          razorpayOrderId: prepared.razorpay?.orderId,
          razorpayPaymentId: prepared.razorpay?.paymentId,
          customerId: customer?.id,
        },
      });
      if (quoted.couponCode) {
        // Counted only while under its limit, so two last-minute orders cannot both use a coupon's final use.
        const counted = await tx.$executeRaw`UPDATE "Coupon" SET used = used + 1 WHERE code = ${quoted.couponCode} AND ("usageLimit" = 0 OR used < "usageLimit")`;
        if (counted === 0) throw new BadRequestException("That coupon has reached its usage limit.");
      }
      if (prepared.razorpay) {
        const claimed = await tx.paymentCheckout.updateMany({
          where: { razorpayOrderId: prepared.razorpay.orderId, usedAt: null },
          data: { usedAt: new Date(), paymentId: prepared.razorpay.paymentId, orderId: created.id },
        });
        if (claimed.count === 0) throw new BadRequestException("This payment has already been used.");
      }
      return created;
    });

    this.notify("confirmed", order);
    return this.present(order);
  }

  /** Refunds a verified payment that could not become an order, once, and records why. */
  private async failPaidCheckout(razorpayOrderId: string, paymentId: string, reason: string) {
    const checkout = await this.prisma.paymentCheckout.findUnique({ where: { razorpayOrderId } });
    if (!checkout) return "failed" as const;
    if (checkout.refundStatus === "pending" || checkout.refundStatus === "refunded") return checkout.refundStatus;
    const refund = await this.payments.refund(paymentId, checkout.amountPaise);
    await this.prisma.paymentCheckout.update({
      where: { razorpayOrderId },
      data: { failedReason: reason, paymentId, refundId: refund.id, refundStatus: refund.status },
    });
    return refund.status;
  }

  /**
   * Refunds a paid order in full, at most once. Demo, free, and cash orders have nothing to refund.
   * A failed refund is recorded so staff can see it and retry.
   */
  async refundOrder(id: string) {
    const order = await this.mustGet(id);
    if (order.paymentStatus !== "paid" || !order.razorpayPaymentId) return this.present(order);
    if (order.refundStatus === "pending" || order.refundStatus === "refunded") return this.present(order);
    const refund = await this.payments.refund(order.razorpayPaymentId, order.total * 100);
    const updated = await this.prisma.order.update({
      where: { id },
      data: { refundStatus: refund.status, refundId: refund.id ?? order.refundId, refundNote: refund.note },
    });
    return this.present(updated);
  }

  /** Staff retry for a refund that failed. */
  async retryRefund(id: string) {
    const order = await this.mustGet(id);
    if (order.refundStatus !== "failed") throw new BadRequestException("Only a failed refund can be retried.");
    if (!["Cancelled", "Returned"].includes(order.status)) throw new BadRequestException("Only cancelled or returned orders are refunded.");
    return this.refundOrder(id);
  }

  private requireOnlinePayments() {
    if (this.payments.mode() === "off") {
      throw new BadRequestException("Online payment is not available yet. Choose cash on delivery.");
    }
  }

  // Callers check who may act on the order (OrdersController.authorize).
  async cancel(id: string) {
    const order = await this.mustGet(id);
    if (["Shipped", "Out for delivery", "Delivered", "Cancelled", "Returned", "Return requested"].includes(order.status)) {
      throw new BadRequestException("This order can no longer be cancelled.");
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.restock(tx, order.items);
      await this.releaseCoupon(tx, order.coupon);
      return tx.order.update({
        where: { id },
        data: {
          status: "Cancelled",
          timeline: [...(order.timeline as { status: string; date: string }[]), { status: "Cancelled", date: new Date().toISOString() }],
        },
      });
    });
    const result = await this.refundOrder(updated.id);
    this.notify("cancelled", await this.mustGet(updated.id));
    return result;
  }

  async requestReturn(id: string, request: Record<string, unknown>) {
    const order = await this.mustGet(id);
    if (order.status !== "Delivered") throw new BadRequestException("Returns open after delivery.");
    const rules = await this.settings();
    const delivered = (order.timeline as { status: string; date: string }[]).find((event) => event.status === "Delivered");
    if (delivered && Date.now() - new Date(delivered.date).getTime() > rules.returnWindowDays * 86400000) {
      throw new BadRequestException(`The ${rules.returnWindowDays}-day return window has closed.`);
    }
    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        status: "Return requested",
        returnRequest: { ...request, status: request.status ?? "Awaiting review", requestedAt: new Date().toISOString() },
      },
    });
    this.notify("return-requested", updated);
    return this.present(updated);
  }

  async update(id: string, patch: { status?: string; notes?: string }) {
    const order = await this.mustGet(id);
    const timeline = order.timeline as { status: string; date: string }[];
    const statusChanged = Boolean(patch.status && patch.status !== order.status);
    if (statusChanged && !(NEXT_STATUS[order.status] ?? []).includes(patch.status!)) {
      const next = NEXT_STATUS[order.status] ?? [];
      throw new BadRequestException(
        next.length ? `A ${order.status.toLowerCase()} order can move to ${next.join(", ")}.` : `A ${order.status.toLowerCase()} order cannot change status here.`,
      );
    }
    const release = statusChanged && patch.status === "Cancelled";
    const updated = await this.prisma.$transaction(async (tx) => {
      if (release) {
        await this.restock(tx, order.items);
        await this.releaseCoupon(tx, order.coupon);
      }
      return tx.order.update({
        where: { id },
        data: {
          status: patch.status ?? order.status,
          notes: patch.notes ?? order.notes,
          timeline: statusChanged ? [...timeline, { status: patch.status, date: new Date().toISOString() }] : timeline,
        },
      });
    });
    const kind = statusMail(updated.status);
    if (statusChanged && updated.status === "Cancelled") {
      const result = await this.refundOrder(updated.id);
      this.notify("cancelled", await this.mustGet(updated.id));
      return result;
    }
    if (statusChanged && kind) this.notify(kind, updated);
    return this.present(updated);
  }

  async ship(id: string, shipment: { courier: string; tracking: string }) {
    const order = await this.mustGet(id);
    if (!["Confirmed", "Packed", "Shipped"].includes(order.status)) throw new BadRequestException(`A ${order.status.toLowerCase()} order cannot be shipped.`);
    const alreadyShipped = order.status === "Shipped";
    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        status: "Shipped",
        shipment: { ...shipment, createdAt: new Date().toISOString() },
        trackingUrl: "https://www.shiprocket.in/",
        timeline: [...(order.timeline as { status: string; date: string }[]), { status: "Shipped", date: new Date().toISOString() }],
      },
    });
    if (!alreadyShipped) this.notify("shipped", updated);
    return this.present(updated);
  }

  async decideReturn(id: string, decision: "Approved" | "Rejected") {
    const order = await this.mustGet(id);
    const request = order.returnRequest as { resolution?: string; status?: string } | null;
    if (!request) throw new BadRequestException("There is no return request on this order.");
    if (order.status !== "Return requested") throw new BadRequestException("This return has already been decided.");
    const approvedRefund = decision === "Approved" && request.resolution === "refund";
    const updated = await this.prisma.$transaction(async (tx) => {
      if (approvedRefund && order.status !== "Returned") await this.restock(tx, order.items);
      return tx.order.update({
        where: { id },
        data: {
          status: decision === "Rejected" ? "Delivered" : approvedRefund ? "Returned" : order.status,
          returnRequest: { ...request, status: decision, decidedAt: new Date().toISOString() },
        },
      });
    });
    const kind: OrderMail = decision === "Rejected" ? "return-declined" : request.resolution === "exchange" ? "return-exchange" : approvedRefund ? "return-approved" : "returned";
    if (approvedRefund) {
      const result = await this.refundOrder(updated.id);
      this.notify(kind, await this.mustGet(updated.id));
      return result;
    }
    this.notify(kind, updated);
    return this.present(updated);
  }

  private async restock(tx: Prisma.TransactionClient, items: unknown) {
    const lines = ((items as { slug?: string; color?: string; size?: string; quantity?: number }[]) ?? []).filter((item) => item.slug);
    for (const slug of [...new Set(lines.map((item) => item.slug!))].sort()) {
      await tx.$queryRaw`SELECT slug FROM "Product" WHERE slug = ${slug} FOR UPDATE`;
    }
    for (const item of lines) {
      if (!item.slug || !item.color || !item.size || !item.quantity) continue;
      const product = await tx.product.findUnique({ where: { slug: item.slug } });
      if (!product) continue;
      const stock = { ...(product.stock as Record<string, number>) };
      const key = `${item.color}|${item.size}`;
      stock[key] = (stock[key] ?? 0) + item.quantity;
      await tx.product.update({ where: { slug: item.slug }, data: { stock } });
    }
  }

  private async releaseCoupon(tx: Prisma.TransactionClient, code: string | null) {
    if (!code) return;
    const coupon = await tx.coupon.findUnique({ where: { code } });
    if (coupon && coupon.used > 0) {
      await tx.coupon.update({ where: { code }, data: { used: { decrement: 1 } } });
    }
  }

  present(order: {
    id: string;
    number: string;
    createdAt: Date;
    email: string;
    phone: string;
    address: unknown;
    items: unknown;
    delivery: string;
    payment: string;
    subtotal: number;
    discount: number;
    shipping: number;
    codFee: number;
    total: number;
    coupon: string | null;
    status: string;
    timeline: unknown;
    notes: string;
    trackingUrl: string | null;
    shipment: unknown;
    returnRequest: unknown;
    paymentStatus?: string;
    refundStatus?: string;
    refundNote?: string;
    accessKey?: string;
  }) {
    return {
      ...order,
      createdAt: order.createdAt.toISOString(),
      coupon: order.coupon ?? undefined,
      notes: order.notes || undefined,
      trackingUrl: order.trackingUrl ?? undefined,
      shipment: order.shipment ?? undefined,
      returnRequest: order.returnRequest ?? undefined,
    };
  }

  private async paidInput(input: PlaceInput, trusted?: boolean): Promise<Prepared> {
    if (input.payment === "cod") return { ...input, razorpay: undefined, paymentStatus: "cod" };
    this.requireOnlinePayments();
    if (this.payments.mode() === "demo") return { ...input, razorpay: undefined, paymentStatus: "demo" };
    const proof = input.razorpay;
    if (!proof?.orderId || !proof.paymentId) {
      // A ₹0 order (a full coupon) has nothing to charge.
      if ((await this.quote(input)).total === 0) return { ...input, razorpay: undefined, paymentStatus: "free" };
      throw new BadRequestException("Payment was not completed.");
    }
    if (!trusted && !this.payments.verifyPayment(proof.orderId, proof.paymentId, proof.signature || "")) {
      throw new BadRequestException("Payment could not be verified.");
    }
    const checkout = await this.prisma.paymentCheckout.findUnique({ where: { razorpayOrderId: proof.orderId } });
    if (!checkout) throw new BadRequestException("Payment could not be verified.");
    // The order is built from what was stored when payment began, never from what the browser sends now.
    const stored = checkout.payload as PlaceInput;
    if (checkout.usedAt && checkout.orderId) {
      const existing = await this.prisma.order.findUnique({ where: { id: checkout.orderId } });
      if (existing) return { ...stored, razorpay: proof, paymentStatus: "paid", existingOrderId: existing.id };
    }
    if (checkout.usedAt) throw new BadRequestException("This payment has already been used.");
    if (checkout.failedReason) {
      throw new BadRequestException(`${checkout.failedReason} This payment ${checkout.refundStatus === "failed" ? "is waiting for a refund from the studio" : "has been refunded"}.`);
    }
    return { ...stored, razorpay: proof, paymentStatus: "paid", amountPaise: checkout.amountPaise };
  }

  private async quote(input: PlaceInput) {
    if (!input.items?.length) throw new BadRequestException("Your bag is empty.");
    if (!["upi", "card", "netbanking", "cod"].includes(input.payment)) {
      throw new BadRequestException("Choose UPI, card, net banking, or cash on delivery.");
    }
    const rules = await this.settings();
    // Before anything is priced or paid for: a real PIN, the right state for it, and a state the studio delivers to.
    const address = checkDeliveryAddress(input.address, rules);
    const phone = cleanMobile(input.phone);
    const items = [];
    for (const item of input.items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new BadRequestException("Choose a quantity of at least 1.");
      const product = await this.prisma.product.findUnique({ where: { slug: item.slug } });
      if (!product || !(await isOnSale(this.prisma, product))) throw new BadRequestException(`${item.slug} is no longer available.`);
      const stock = product.stock as Record<string, number>;
      const key = `${item.color}|${item.size}`;
      if ((stock[key] ?? 0) < item.quantity) {
        throw new BadRequestException(`${product.name} in ${item.color}, size ${item.size} is no longer available.`);
      }
      const colors = product.colors as { name: string; hex: string }[];
      items.push({
        slug: product.slug,
        name: product.name,
        price: livePrice(product, {
          saleEnabled: rules.saleEnabled === true,
          salePercent: Number(rules.salePercent) || 0,
          saleStart: typeof rules.saleStart === "string" ? rules.saleStart : "",
          saleEnd: typeof rules.saleEnd === "string" ? rules.saleEnd : "",
        }),
        color: item.color,
        hex: colors.find((color) => color.name === item.color)?.hex ?? "#e4d7c4",
        size: item.size,
        quantity: item.quantity,
        stockKey: key,
      });
    }
    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const stored = input.coupon ? await this.prisma.coupon.findUnique({ where: { code: input.coupon.trim().toUpperCase() } }) : null;
    const coupon = stored && isCouponType(stored.type) ? { ...stored, type: stored.type } : null;
    const priced = coupon ? evaluateCoupon(coupon, subtotal) : undefined;
    if (coupon && priced && !priced.ok) throw new BadRequestException(priced.reason);
    const discount = priced && priced.ok && coupon?.type !== "free_shipping" ? priced.discount : 0;
    const afterDiscount = Math.max(0, subtotal - discount);
    const shipping = shippingFee(afterDiscount, input.delivery, coupon?.type === "free_shipping", rules);
    const codFee = input.payment === "cod" ? Number(rules.codFee) : 0;
    const total = afterDiscount + shipping + codFee;
    if (input.payment === "cod" && rules.codEnabled === false) throw new BadRequestException("Cash on delivery is turned off.");
    if (input.payment === "cod" && total > Number(rules.codMax)) {
      throw new BadRequestException(`Cash on delivery is available on orders up to ₹${Number(rules.codMax).toLocaleString("en-IN")}.`);
    }
    return { items, subtotal, discount, shipping, codFee, total, couponCode: coupon?.code, address, phone };
  }

  /**
   * Email and WhatsApp go out in the background: a slow provider never holds up checkout or the admin,
   * and a failure is logged without undoing the order change that caused it.
   */
  private notify(kind: OrderMail, order: Parameters<OrdersService["toMail"]>[0] & { phone: string; paymentStatus?: string; refundStatus?: string }) {
    const message = this.toMail(order);
    void Promise.allSettled([
      this.mail.order(kind, message),
      this.whatsapp.order(kind, { ...message, phone: order.phone, paymentStatus: order.paymentStatus, refundStatus: order.refundStatus }),
    ]).then((results) => {
      for (const result of results) if (result.status === "rejected") console.error(`[notify] “${kind}” for ${order.number} failed`, result.reason);
    });
  }

  private toMail(order: {
    email: string;
    number: string;
    address: unknown;
    items: unknown;
    total: number;
    payment: string;
    delivery: string;
    trackingUrl: string | null;
    shipment: unknown;
  }): MailOrder {
    const address = (order.address ?? {}) as { name?: string; line1?: string; line2?: string; landmark?: string; city?: string; state?: string; pin?: string };
    const shipment = (order.shipment ?? {}) as { courier?: string; tracking?: string };
    const place = [address.city, address.state].filter(Boolean).join(", ");
    return {
      email: order.email,
      number: order.number,
      name: address.name || "",
      items: (order.items as MailItem[]) ?? [],
      total: order.total,
      payment: order.payment,
      delivery: order.delivery,
      lines: [address.line1, address.line2, address.landmark ? `Near ${address.landmark}` : "", [place, address.pin].filter(Boolean).join(" ")].filter((line): line is string => Boolean(line)),
      courier: shipment.courier,
      tracking: shipment.tracking,
      trackingUrl: order.trackingUrl || undefined,
    };
  }

  private async mustGet(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException("Order not found.");
    return order;
  }
}

function isCouponType(type: string): type is CouponRecord["type"] {
  return type === "percent" || type === "fixed" || type === "free_shipping";
}

function statusMail(status: string): OrderMail | null {
  if (status === "Confirmed") return "confirmed";
  if (status === "Packed") return "packed";
  if (status === "Shipped") return "shipped";
  if (status === "Out for delivery") return "out";
  if (status === "Delivered") return "delivered";
  if (status === "Cancelled") return "cancelled";
  if (status === "Return requested") return "return-requested";
  if (status === "Returned") return "returned";
  return null;
}
