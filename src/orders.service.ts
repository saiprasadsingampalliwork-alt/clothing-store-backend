import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { MailService, type MailItem, type MailOrder, type OrderMail } from "./mail.service";
import { PaymentsService } from "./payments.service";
import { WhatsAppService } from "./whatsapp.service";
import { evaluateCoupon, livePrice, shippingFee, type CouponRecord, type ShippingRules } from "./pricing";

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

@Injectable()
export class OrdersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(WhatsAppService) private readonly whatsapp: WhatsAppService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

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
    const quoted = await this.quote({ ...input, email: email || input.email });
    if (!this.payments.configured()) {
      console.log("[pay] Razorpay is not configured. Online checkout will be recorded without a charge.");
      return { configured: false as const };
    }
    if (quoted.total < 1) throw new BadRequestException("This order does not need a payment.");
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

  async capturePayment(razorpayOrderId: string, paymentId: string) {
    const checkout = await this.prisma.paymentCheckout.findUnique({ where: { razorpayOrderId } });
    if (!checkout || checkout.usedAt) return null;
    return this.place({ ...(checkout.payload as PlaceInput), razorpay: { orderId: razorpayOrderId, paymentId } }, { trustedPayment: true });
  }

  async place(input: PlaceInput, options?: { trustedPayment?: boolean }) {
    const prepared = await this.paidInput(input, options?.trustedPayment);
    if (prepared.existingOrderId) {
      const existing = await this.prisma.order.findUnique({ where: { id: prepared.existingOrderId } });
      if (existing) return this.present(existing);
    }
    const email = prepared.email.trim().toLowerCase();
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (customer?.blocked) throw new BadRequestException("This account is blocked and cannot place an order.");
    const quoted = await this.quote({ ...prepared, email });
    if (prepared.payment !== "cod" && !this.payments.configured()) {
      console.log(`[pay] Razorpay is not configured. Recorded ${prepared.payment} for ${email} without a charge.`);
    }

    let order;
    try {
      order = await this.prisma.$transaction(async (tx) => {
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
          id: `order-${Date.now()}`,
          number: `EA-${sequence.value}`,
          email,
          phone: prepared.phone,
          address: prepared.address as Prisma.InputJsonValue,
          items: quoted.items.map(({ stockKey: _stockKey, ...item }) => item) as Prisma.InputJsonValue,
          delivery: prepared.delivery,
          payment: prepared.payment,
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
      if (quoted.couponCode) await tx.coupon.update({ where: { code: quoted.couponCode }, data: { used: { increment: 1 } } });
      if (prepared.razorpay) {
        const claimed = await tx.paymentCheckout.updateMany({
          where: { razorpayOrderId: prepared.razorpay.orderId, usedAt: null },
          data: { usedAt: new Date(), paymentId: prepared.razorpay.paymentId, orderId: created.id },
        });
        if (claimed.count === 0) throw new BadRequestException("This payment has already been used.");
      }
      return created;
    });
    } catch (error) {
      if (prepared.razorpay && error instanceof BadRequestException) {
        const checkout = await this.prisma.paymentCheckout.findUnique({ where: { razorpayOrderId: prepared.razorpay.orderId } });
        if (checkout?.orderId) {
          const existing = await this.prisma.order.findUnique({ where: { id: checkout.orderId } });
          if (existing) return this.present(existing);
        }
      }
      throw error;
    }

    await this.notify("confirmed", order);
    return this.present(order);
  }

  async cancel(id: string, email?: string) {
    const order = await this.mustGet(id);
    if (email && order.email !== email.toLowerCase()) throw new NotFoundException("Order not found.");
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
    await this.notify("cancelled", updated);
    if (updated.payment !== "cod" && updated.razorpayPaymentId) await this.payments.refund(updated.razorpayPaymentId, updated.total * 100);
    return this.present(updated);
  }

  async requestReturn(id: string, email: string | undefined, request: Record<string, unknown>) {
    const order = await this.mustGet(id);
    if (email && order.email !== email.toLowerCase()) throw new NotFoundException("Order not found.");
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
    await this.notify("return-requested", updated);
    return this.present(updated);
  }

  async update(id: string, patch: { status?: string; notes?: string }) {
    const order = await this.mustGet(id);
    const timeline = order.timeline as { status: string; date: string }[];
    const statusChanged = Boolean(patch.status && patch.status !== order.status);
    const release = statusChanged && patch.status === "Cancelled" && ["Confirmed", "Packed"].includes(order.status);
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
    if (statusChanged && kind) await this.notify(kind, updated);
    if (statusChanged && updated.status === "Cancelled" && updated.payment !== "cod" && updated.razorpayPaymentId) {
      await this.payments.refund(updated.razorpayPaymentId, updated.total * 100);
    }
    return this.present(updated);
  }

  async ship(id: string, shipment: { courier: string; tracking: string }) {
    const order = await this.mustGet(id);
    if (["Cancelled", "Returned"].includes(order.status)) throw new BadRequestException("This order cannot be shipped.");
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
    if (!alreadyShipped) await this.notify("shipped", updated);
    return this.present(updated);
  }

  async decideReturn(id: string, decision: "Approved" | "Rejected") {
    const order = await this.mustGet(id);
    const request = order.returnRequest as { resolution?: string; status?: string } | null;
    if (!request) throw new BadRequestException("There is no return request on this order.");
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
    await this.notify(kind, updated);
    if (approvedRefund && order.status !== "Returned" && updated.payment !== "cod" && updated.razorpayPaymentId) {
      await this.payments.refund(updated.razorpayPaymentId, updated.total * 100);
    }
    return this.present(updated);
  }

  private async restock(tx: Prisma.TransactionClient, items: unknown) {
    for (const item of (items as { slug?: string; color?: string; size?: string; quantity?: number }[]) ?? []) {
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

  private async paidInput(input: PlaceInput, trusted?: boolean): Promise<PlaceInput & { existingOrderId?: string }> {
    if (input.payment === "cod" || !this.payments.configured()) return { ...input, razorpay: undefined };
    const proof = input.razorpay;
    if (!proof?.orderId || !proof.paymentId) throw new BadRequestException("Payment was not completed.");
    if (!trusted && !this.payments.verifyPayment(proof.orderId, proof.paymentId, proof.signature || "")) {
      throw new BadRequestException("Payment could not be verified.");
    }
    const checkout = await this.prisma.paymentCheckout.findUnique({ where: { razorpayOrderId: proof.orderId } });
    if (!checkout) throw new BadRequestException("Payment could not be verified.");
    const stored = checkout.payload as PlaceInput;
    if (checkout.usedAt && checkout.orderId) {
      const existing = await this.prisma.order.findUnique({ where: { id: checkout.orderId } });
      if (existing) return { ...stored, email: stored.email, razorpay: proof, existingOrderId: existing.id };
    }
    if (checkout.usedAt) throw new BadRequestException("This payment has already been used.");
    const quoted = await this.quote(stored);
    if (quoted.total * 100 !== checkout.amountPaise) throw new BadRequestException("The payment amount does not match this order.");
    return { ...stored, email: stored.email, razorpay: proof };
  }

  private async quote(input: PlaceInput) {
    if (!input.items?.length) throw new BadRequestException("Your bag is empty.");
    if (!["upi", "card", "netbanking", "cod"].includes(input.payment)) {
      throw new BadRequestException("Choose UPI, card, net banking, or cash on delivery.");
    }
    const rules = await this.settings();
    const items = [];
    for (const item of input.items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new BadRequestException("Choose a quantity of at least 1.");
      const product = await this.prisma.product.findUnique({ where: { slug: item.slug } });
      if (!product || product.status !== "active") throw new BadRequestException(`${item.slug} is no longer available.`);
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
    return { items, subtotal, discount, shipping, codFee, total, couponCode: coupon?.code };
  }

  private async notify(kind: OrderMail, order: Parameters<OrdersService["toMail"]>[0] & { phone: string }) {
    const message = this.toMail(order);
    await this.mail.order(kind, message);
    await this.whatsapp.order(kind, { ...message, phone: order.phone });
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
    const address = (order.address ?? {}) as { name?: string; line1?: string; line2?: string; city?: string; state?: string; pin?: string };
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
      lines: [address.line1, address.line2, [place, address.pin].filter(Boolean).join(" ")].filter((line): line is string => Boolean(line)),
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
