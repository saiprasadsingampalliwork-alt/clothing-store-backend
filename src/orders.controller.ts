import { Body, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
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
  async one(@Param("id") id: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException("Order not found.");
    return this.orders.present(order);
  }

  @Post()
  place(@Body() body: Parameters<OrdersService["place"]>[0]) {
    return this.orders.place(body);
  }

  @Post(":id/cancel")
  cancel(@Req() req: Request, @Param("id") id: string) {
    const staff = actorFrom(req);
    const customer = customerFrom(req);
    return this.orders.cancel(id, staff?.kind === "staff" ? undefined : customer?.email);
  }

  @Post(":id/return")
  requestReturn(@Req() req: Request, @Param("id") id: string, @Body() body: Record<string, unknown>) {
    const customer = customerFrom(req);
    return this.orders.requestReturn(id, customer?.email, body);
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

  private requireStaff(req: Request) {
    const actor = actorFrom(req);
    if (!actor || actor.kind !== "staff") throw new UnauthorizedException("Staff sign-in is required.");
  }
}
