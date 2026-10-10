import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { evaluateCoupon, livePrice, shippingFee, type ShippingRules } from "./pricing";

type ItemInput = { slug: string; color: string; size: string; quantity: number };

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
};

@Injectable()
export class OrdersService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async settings(): Promise<ShippingRules & Record<string, unknown>> {
    const row = await this.prisma.setting.findUnique({ where: { id: "store" } });
    return { ...defaultSettings, ...((row?.data as object) ?? {}) };
  }

  async place(input: {
    email: string;
    phone: string;
    address: Record<string, unknown>;
    delivery: "standard" | "express";
    payment: "upi" | "card" | "netbanking" | "cod";
    coupon?: string;
    items: ItemInput[];
  }) {
    const email = input.email.trim().toLowerCase();
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (customer?.blocked) throw new BadRequestException("This account is blocked and cannot place an order.");
    if (!input.items?.length) throw new BadRequestException("Your bag is empty.");

    const rules = await this.settings();
    const pricedItems = [];
    for (const item of input.items) {
      const product = await this.prisma.product.findUnique({ where: { slug: item.slug } });
      if (!product || product.status !== "active") throw new BadRequestException(`${item.slug} is no longer available.`);
      const stock = product.stock as Record<string, number>;
      const key = `${item.color}|${item.size}`;
      if ((stock[key] ?? 0) < item.quantity) {
        throw new BadRequestException(`${product.name} in ${item.color}, size ${item.size} is no longer available.`);
      }
      const colors = product.colors as { name: string; hex: string }[];
      pricedItems.push({
        slug: product.slug,
        name: product.name,
        price: livePrice(product),
        color: item.color,
        hex: colors.find((color) => color.name === item.color)?.hex ?? "#e4d7c4",
        size: item.size,
        quantity: item.quantity,
        stockKey: key,
      });
    }

    const subtotal = pricedItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const coupon = input.coupon
      ? await this.prisma.coupon.findUnique({ where: { code: input.coupon.trim().toUpperCase() } })
      : null;
    const priced = coupon ? evaluateCoupon(coupon, subtotal) : undefined;
    if (coupon && priced && !priced.ok) throw new BadRequestException(priced.reason);
    const discount = priced && priced.ok && coupon?.type !== "free_shipping" ? priced.discount : 0;
    const afterDiscount = Math.max(0, subtotal - discount);
    const shipping = shippingFee(afterDiscount, input.delivery, coupon?.type === "free_shipping", rules);
    const codFee = input.payment === "cod" ? rules.codFee : 0;
    const total = afterDiscount + shipping + codFee;
    if (input.payment === "cod" && rules.codEnabled === false) throw new BadRequestException("Cash on delivery is turned off.");
    if (input.payment === "cod" && total > rules.codMax) {
      throw new BadRequestException(`Cash on delivery is available on orders up to ₹${rules.codMax.toLocaleString("en-IN")}.`);
    }

    const order = await this.prisma.$transaction(async (tx) => {
      for (const item of pricedItems) {
        const product = await tx.product.findUnique({ where: { slug: item.slug } });
        const stock = { ...(product!.stock as Record<string, number>) };
        stock[item.stockKey] = (stock[item.stockKey] ?? 0) - item.quantity;
        await tx.product.update({ where: { slug: item.slug }, data: { stock } });
      }
      const sequence = await tx.sequence.update({ where: { id: "order" }, data: { value: { increment: 1 } } });
      const created = await tx.order.create({
        data: {
          id: `order-${Date.now()}`,
          number: `EA-${sequence.value}`,
          email,
          phone: input.phone,
          address: input.address as Prisma.InputJsonValue,
          items: pricedItems.map(({ stockKey: _stockKey, ...item }) => item) as Prisma.InputJsonValue,
          delivery: input.delivery,
          payment: input.payment,
          subtotal,
          discount,
          shipping,
          codFee,
          total,
          coupon: coupon?.code,
          status: "Confirmed",
          timeline: [{ status: "Confirmed", date: new Date().toISOString() }],
          trackingUrl: "https://www.shiprocket.in/",
          customerId: customer?.id,
        },
      });
      if (coupon) await tx.coupon.update({ where: { code: coupon.code }, data: { used: { increment: 1 } } });
      return created;
    });

    return this.present(order);
  }

  async cancel(id: string, email?: string) {
    const order = await this.mustGet(id);
    if (email && order.email !== email.toLowerCase()) throw new NotFoundException("Order not found.");
    if (["Shipped", "Out for delivery", "Delivered", "Cancelled", "Returned"].includes(order.status)) {
      throw new BadRequestException("This order can no longer be cancelled.");
    }
    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        status: "Cancelled",
        timeline: [...(order.timeline as { status: string; date: string }[]), { status: "Cancelled", date: new Date().toISOString() }],
      },
    });
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
    return this.present(updated);
  }

  async update(id: string, patch: { status?: string; notes?: string }) {
    const order = await this.mustGet(id);
    const timeline = order.timeline as { status: string; date: string }[];
    const statusChanged = patch.status && patch.status !== order.status;
    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        status: patch.status ?? order.status,
        notes: patch.notes ?? order.notes,
        timeline: statusChanged ? [...timeline, { status: patch.status, date: new Date().toISOString() }] : timeline,
      },
    });
    return this.present(updated);
  }

  async ship(id: string, shipment: { courier: string; tracking: string }) {
    const order = await this.mustGet(id);
    if (["Cancelled", "Returned"].includes(order.status)) throw new BadRequestException("This order cannot be shipped.");
    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        status: "Shipped",
        shipment: { ...shipment, createdAt: new Date().toISOString() },
        trackingUrl: "https://www.shiprocket.in/",
        timeline: [...(order.timeline as { status: string; date: string }[]), { status: "Shipped", date: new Date().toISOString() }],
      },
    });
    return this.present(updated);
  }

  async decideReturn(id: string, decision: "Approved" | "Rejected") {
    const order = await this.mustGet(id);
    const request = order.returnRequest as { resolution?: string; status?: string } | null;
    if (!request) throw new BadRequestException("There is no return request on this order.");
    const approvedRefund = decision === "Approved" && request.resolution === "refund";
    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        status: decision === "Rejected" ? "Delivered" : approvedRefund ? "Returned" : order.status,
        returnRequest: { ...request, status: decision, decidedAt: new Date().toISOString() },
      },
    });
    return this.present(updated);
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

  private async mustGet(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException("Order not found.");
    return order;
  }
}
