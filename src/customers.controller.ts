import { randomUUID } from "crypto";
import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, UnauthorizedException } from "@nestjs/common";
import { hash, compare } from "bcryptjs";
import type { Request } from "express";
import { actorFrom, customerFrom, signToken } from "./auth";
import { PrismaService } from "./prisma.service";

@Controller("customers")
export class CustomersController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Post("register")
  async register(@Body() body: { name: string; email: string; phone: string; password: string }) {
    const email = body.email.trim().toLowerCase();
    const existing = await this.prisma.customer.findUnique({ where: { email } });
    if (existing) throw new BadRequestException("An account with that email already exists.");
    const customer = await this.prisma.customer.create({
      data: {
        name: body.name,
        email,
        phone: body.phone,
        passwordHash: await hash(body.password, 10),
        addresses: [],
      },
    });
    return { token: signToken({ kind: "customer", email }), user: publicCustomer(customer) };
  }

  @Post("login")
  async login(@Body() body: { email: string; password: string }) {
    const email = body.email.trim().toLowerCase();
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (!customer || !(await compare(body.password, customer.passwordHash))) {
      throw new BadRequestException("Email or password is incorrect.");
    }
    if (customer.blocked) throw new BadRequestException("This account is blocked. Write to the studio if this is a mistake.");
    return { token: signToken({ kind: "customer", email }), user: publicCustomer(customer) };
  }

  @Post("reset-password")
  async reset(@Body() body: { email: string; password: string }) {
    const email = body.email.trim().toLowerCase();
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (!customer) throw new BadRequestException("No account uses that email.");
    await this.prisma.customer.update({ where: { email }, data: { passwordHash: await hash(body.password, 10) } });
    return { ok: true };
  }

  @Get("me")
  async me(@Req() req: Request) {
    const actor = customerFrom(req) ?? actorFrom(req);
    if (!actor || actor.kind !== "customer") throw new UnauthorizedException("Sign in to continue.");
    const customer = await this.prisma.customer.findUnique({ where: { email: actor.email } });
    if (!customer) throw new UnauthorizedException("Sign in to continue.");
    return publicCustomer(customer);
  }

  @Patch("me")
  async updateMe(@Req() req: Request, @Body() body: { name?: string; phone?: string }) {
    const customer = await this.requireCustomer(req);
    const updated = await this.prisma.customer.update({
      where: { id: customer.id },
      data: { name: body.name ?? customer.name, phone: body.phone ?? customer.phone },
    });
    return publicCustomer(updated);
  }

  @Post("me/addresses")
  async saveAddress(@Req() req: Request, @Body() address: { id: string; isDefault?: boolean }) {
    const customer = await this.requireCustomer(req);
    const current = (customer.addresses as { id: string; isDefault?: boolean }[]) ?? [];
    const next = current.some((entry) => entry.id === address.id)
      ? current.map((entry) => (entry.id === address.id ? address : entry))
      : [...current, address];
    const addresses = address.isDefault ? next.map((entry) => ({ ...entry, isDefault: entry.id === address.id })) : next;
    const updated = await this.prisma.customer.update({ where: { id: customer.id }, data: { addresses } });
    return publicCustomer(updated);
  }

  @Delete("me/addresses/:id")
  async removeAddress(@Req() req: Request, @Param("id") id: string) {
    const customer = await this.requireCustomer(req);
    const addresses = ((customer.addresses as { id: string }[]) ?? []).filter((address) => address.id !== id);
    const updated = await this.prisma.customer.update({ where: { id: customer.id }, data: { addresses } });
    return publicCustomer(updated);
  }

  @Get()
  async list(@Req() req: Request) {
    this.requireStaff(req);
    const customers = await this.prisma.customer.findMany({ orderBy: { createdAt: "asc" } });
    return customers.map(publicCustomer);
  }

  @Patch(":email/block")
  async block(@Req() req: Request, @Param("email") email: string, @Body() body: { blocked: boolean }) {
    this.requireStaff(req);
    const normalized = decodeURIComponent(email).toLowerCase();
    const existing = await this.prisma.customer.findUnique({ where: { email: normalized } });
    if (!existing) {
      const created = await this.prisma.customer.create({
        data: {
          name: normalized,
          email: normalized,
          phone: "",
          passwordHash: await hash(randomUUID(), 10),
          blocked: body.blocked,
          addresses: [],
        },
      });
      return publicCustomer(created);
    }
    const updated = await this.prisma.customer.update({
      where: { email: normalized },
      data: { blocked: body.blocked },
    });
    return publicCustomer(updated);
  }

  private async requireCustomer(req: Request) {
    const actor = customerFrom(req) ?? actorFrom(req);
    if (!actor || actor.kind !== "customer") throw new UnauthorizedException("Sign in to continue.");
    const customer = await this.prisma.customer.findUnique({ where: { email: actor.email } });
    if (!customer) throw new UnauthorizedException("Sign in to continue.");
    return customer;
  }

  private requireStaff(req: Request) {
    const actor = actorFrom(req);
    if (!actor || actor.kind !== "staff") throw new UnauthorizedException("Staff sign-in is required.");
    return actor;
  }
}

export function publicCustomer(customer: { id: string; name: string; email: string; phone: string; blocked: boolean; addresses: unknown }) {
  return {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    blocked: customer.blocked,
    addresses: customer.addresses,
  };
}
