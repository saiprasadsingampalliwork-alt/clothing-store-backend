import { Body, Controller, Get, Headers, Inject, NotFoundException, Param, Patch, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { timingSafeEqual } from "crypto";
import { actorFrom, customerFrom } from "./auth";
import { OrdersService } from "./orders.service";
import { PrismaService } from "./prisma.service";

@Controller("orders")
export class OrdersController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    const staff = actorFrom(req);
    if (staff?.kind === "staff") {
      const rows = await this.prisma.order.findMany({ orderBy: { createdAt: "desc" } });
      return rows.map((order) => this.orders.present(order));
    }
    const customer = customerFrom(req);
    if (!customer) return [];
    const rows = await this.prisma.order.findMany({ where: { email: customer.email }, orderBy: { createdAt: "desc" } });
    return rows.map((order) => this.orders.present(order));
  }

  @Get(":id")
  async one(@Req() req: Request, @Param("id") id: string, @Headers("x-order-key") key?: string) {
    return this.orders.present(await this.authorize(req, id, key));
  }

  @Post()
  place(@Body() body: Parameters<OrdersService["place"]>[0]) {
    return this.orders.place(body);
  }

  @Post(":id/cancel")
  async cancel(@Req() req: Request, @Param("id") id: string, @Headers("x-order-key") key?: string) {
    await this.authorize(req, id, key);
    return this.orders.cancel(id);
  }

  @Post(":id/return")
  async requestReturn(@Req() req: Request, @Param("id") id: string, @Body() body: Record<string, unknown>, @Headers("x-order-key") key?: string) {
    await this.authorize(req, id, key);
    return this.orders.requestReturn(id, body);
  }

  @Patch(":id")
  update(@Req() req: Request, @Param("id") id: string, @Body() body: { status?: string; notes?: string }) {
    this.requireStaff(req);
    return this.orders.update(id, body);
  }

  @Post(":id/shipment")
  ship(@Req() req: Request, @Param("id") id: string, @Body() body: { courier: string; tracking: string }) {
    this.requireStaff(req);
    return this.orders.ship(id, body);
  }

  @Post(":id/return-decision")
  decide(@Req() req: Request, @Param("id") id: string, @Body() body: { decision: "Approved" | "Rejected" }) {
    this.requireStaff(req);
    return this.orders.decideReturn(id, body.decision);
  }

  @Post(":id/refund")
  retryRefund(@Req() req: Request, @Param("id") id: string) {
    this.requireStaff(req);
    return this.orders.retryRefund(id);
  }

  /**
   * Staff, the signed-in customer who placed the order, or anyone holding the order's access key
   * (a guest's browser keeps it). Everyone else gets "not found", so order numbers cannot be probed.
   */
  private async authorize(req: Request, id: string, key?: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException("Order not found.");
    if (actorFrom(req)?.kind === "staff") return order;
    const customer = customerFrom(req);
    if (customer?.kind === "customer" && customer.email.toLowerCase() === order.email.toLowerCase()) return order;
    if (key && order.accessKey && sameKey(key, order.accessKey)) return order;
    throw new NotFoundException("Order not found.");
  }

  private requireStaff(req: Request) {
    const actor = actorFrom(req);
    if (!actor || actor.kind !== "staff") throw new UnauthorizedException("Staff sign-in is required.");
  }
}

function sameKey(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
