import { Controller, Get, Inject, Query, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { actorFrom } from "./auth";
import { PrismaService } from "./prisma.service";

@Controller("reports")
export class ReportsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  async summary(@Req() req: Request, @Query("range") range?: string) {
    const actor = actorFrom(req);
    if (!actor || actor.kind !== "staff") throw new UnauthorizedException("Staff sign-in is required.");
    const [orders, products, categories] = await Promise.all([
      this.prisma.order.findMany({ orderBy: { createdAt: "desc" } }),
      this.prisma.product.findMany({ select: { slug: true, category: true } }),
      this.prisma.category.findMany(),
    ]);
    const names = new Map(categories.map((category) => [category.slug, category.label]));
    const categoryOf = new Map(products.map((product) => [product.slug, names.get(product.category) ?? label(product.category)]));
    const now = Date.now();
    const recent = range === "30";
    const live = orders.filter((order) => {
      if (order.status === "Cancelled") return false;
      if (!recent) return true;
      return now - order.createdAt.getTime() <= 30 * 86400000;
    });
    const previous = orders.filter((order) => {
      const age = now - order.createdAt.getTime();
      return order.status !== "Cancelled" && age > 30 * 86400000 && age <= 60 * 86400000;
    });
    const net = live.reduce((sum, order) => sum + order.total, 0);
    const priorNet = previous.reduce((sum, order) => sum + order.total, 0);
    const refunds = live.filter((order) => order.status === "Returned").reduce((sum, order) => sum + order.total, 0);
    const byCategory = new Map<string, number>([
      ["Tops", 0],
      ["Bottoms", 0],
      ["Outerwear", 0],
    ]);
    const byPayment = new Map<string, number>([
      ["UPI", 0],
      ["Cards", 0],
      ["COD", 0],
      ["Net banking", 0],
    ]);
    let taxable = 0;
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    const months = new Map<string, { label: string; orders: number; taxable: number; cgst: number; sgst: number; igst: number }>();
    for (const order of live) {
      const method = order.payment === "card" ? "Cards" : order.payment === "cod" ? "COD" : order.payment === "netbanking" ? "Net banking" : "UPI";
      byPayment.set(method, (byPayment.get(method) ?? 0) + order.total);
      const gst = split(order);
      taxable += gst.taxable;
      cgst += gst.cgst;
      sgst += gst.sgst;
      igst += gst.igst;
      const key = `${order.createdAt.getFullYear()}-${order.createdAt.getMonth()}`;
      const current = order.createdAt.getMonth() === new Date().getMonth() && order.createdAt.getFullYear() === new Date().getFullYear();
      const name = order.createdAt.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
      const bucket = months.get(key) ?? { label: name, orders: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      if (current) bucket.label = `${order.createdAt.toLocaleDateString("en-GB", { month: "long" })} ${order.createdAt.getFullYear()} (to date)`;
      bucket.orders += 1;
      bucket.taxable += gst.taxable;
      bucket.cgst += gst.cgst;
      bucket.sgst += gst.sgst;
      bucket.igst += gst.igst;
      months.set(key, bucket);
      for (const item of order.items as { slug?: string; price?: number; quantity?: number }[]) {
        const category = categoryOf.get(item.slug ?? "") ?? "Tops";
        byCategory.set(category, (byCategory.get(category) ?? 0) + (item.price ?? 0) * (item.quantity ?? 0));
      }
    }
    const categoryTotal = [...byCategory.values()].reduce((sum, value) => sum + value, 0) || 1;
    const paymentTotal = [...byPayment.values()].reduce((sum, value) => sum + value, 0) || 1;
    return {
      net,
      orders: live.length,
      avg: live.length ? Math.round(net / live.length) : 0,
      gst: cgst + sgst + igst,
      refunds,
      change: priorNet ? Math.round(((net - priorNet) / priorNet) * 100) : 0,
      hasPrior: priorNet > 0,
      byCategory: [...byCategory.entries()].map(([label, total]) => ({ label, total, share: Math.round((total / categoryTotal) * 100) })),
      byPayment: [...byPayment.entries()].map(([label, total]) => ({ label, total, share: Math.round((total / paymentTotal) * 100) })),
      months: [...months.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([key, row]) => ({ key, ...row })),
    };
  }
}

function label(category: string) {
  return category
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function includedGst(price: number) {
  const rate = price <= 1000 ? 0.05 : 0.12;
  const tax = Math.round((price * rate) / (1 + rate));
  return { tax, taxable: price - tax };
}

function split(order: { address: unknown; items: unknown }) {
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  let taxable = 0;
  const state = (order.address as { state?: string } | null)?.state;
  const same = state === "Karnataka";
  for (const item of order.items as { price?: number; quantity?: number }[]) {
    const gst = includedGst(item.price ?? 0);
    const qty = item.quantity ?? 0;
    const tax = gst.tax * qty;
    taxable += gst.taxable * qty;
    if (same) {
      const half = Math.round(tax / 2);
      cgst += half;
      sgst += tax - half;
    } else {
      igst += tax;
    }
  }
  return { taxable, cgst, sgst, igst };
}
