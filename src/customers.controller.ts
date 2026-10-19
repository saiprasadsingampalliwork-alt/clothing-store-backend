import { randomInt, randomUUID, timingSafeEqual } from "crypto";
import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Req, UnauthorizedException } from "@nestjs/common";
import { hash, compare } from "bcryptjs";
import type { Request } from "express";
import { actorFrom, customerFrom, signToken } from "./auth";
import { hashToken, MailService } from "./mail.service";
import { PrismaService } from "./prisma.service";
import { cartKey, wishlistKey } from "./nudges.service";
import { WhatsAppService } from "./whatsapp.service";

const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;

@Controller("customers")
export class CustomersController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(WhatsAppService) private readonly whatsapp: WhatsAppService,
  ) {}

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

  @Post("login-code")
  async loginCode(@Body() body: { phone?: string }) {
    const phone = nationalMobile(body.phone || "");
    if (!phone) throw new BadRequestException("Enter a 10-digit mobile number.");
    const matches = await this.prisma.customer.findMany({ where: { phone } });
    if (matches.length > 1) throw new BadRequestException("That mobile is on more than one account. Sign in with email.");
    if (matches.length === 0) throw new BadRequestException("No account uses that mobile.");
    const customer = matches[0];
    if (customer.blocked) throw new BadRequestException("This account is blocked. Write to the studio if this is a mistake.");
    await this.prisma.passwordReset.deleteMany({ where: { email: customer.email, purpose: "login", usedAt: null } });
    const code = await this.saveCode(customer.email, "login");
    const result = await this.whatsapp.signInCode(phone, code);
    return { ok: true, previewCode: result.skipped ? code : undefined };
  }

  @Post("login-code/verify")
  async loginWithCode(@Body() body: { phone?: string; code?: string }) {
    const phone = nationalMobile(body.phone || "");
    if (!phone) throw new BadRequestException("That code is not valid. Request a new one.");
    const matches = await this.prisma.customer.findMany({ where: { phone } });
    if (matches.length !== 1) throw new BadRequestException("That code is not valid. Request a new one.");
    const customer = matches[0];
    if (customer.blocked) throw new BadRequestException("This account is blocked. Write to the studio if this is a mistake.");
    await this.matchCode(customer.email, "login", body.code);
    return { token: signToken({ kind: "customer", email: customer.email }), user: publicCustomer(customer) };
  }

  @Post("forgot-password")
  async forgot(@Body() body: { email?: string; phone?: string }) {
    if (body.phone?.trim()) return this.forgotByPhone(body.phone);
    const email = body.email?.trim().toLowerCase();
    const customer = email ? await this.prisma.customer.findUnique({ where: { email } }) : null;
    if (!customer) return { ok: true };
    const reset = this.mail.newResetToken();
    await this.prisma.passwordReset.deleteMany({ where: { email, purpose: "reset", usedAt: null } });
    await this.prisma.passwordReset.create({ data: { email, tokenHash: reset.tokenHash, expiresAt: reset.expiresAt } });
    const url = `${this.mail.appUrl()}/reset-password?token=${reset.token}`;
    const result = await this.mail.passwordReset(email, url);
    return { ok: true, previewUrl: result.skipped ? url : undefined };
  }

  @Post("reset-password")
  async reset(@Body() body: { token?: string; phone?: string; code?: string; password: string }) {
    if (!body.password || body.password.length < 8) throw new BadRequestException("Use at least 8 characters.");
    if (body.phone?.trim()) return this.resetWithCode(body.phone, body.code, body.password);
    const token = body.token?.trim();
    if (!token) throw new BadRequestException("This link is not valid. Request a new one.");
    const row = await this.prisma.passwordReset.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.usedAt || row.purpose !== "reset") throw new BadRequestException("This link is not valid. Request a new one.");
    if (row.expiresAt.getTime() < Date.now()) throw new BadRequestException("This link has expired. Request a new one.");
    await this.prisma.customer.update({ where: { email: row.email }, data: { passwordHash: await hash(body.password, 10) } });
    await this.prisma.passwordReset.update({ where: { id: row.id }, data: { usedAt: new Date() } });
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

  @Put("me/bag")
  async saveBag(@Req() req: Request, @Body() body: { cart?: unknown; wishlist?: unknown }) {
    const customer = await this.requireCustomer(req);
    const cart = Array.isArray(body.cart) ? body.cart.slice(0, 40) : [];
    const wishlist = Array.isArray(body.wishlist) ? body.wishlist.slice(0, 40) : [];
    const nextCartKey = cartKey(cart);
    const nextWishKey = wishlistKey(wishlist);
    const cartChanged = nextCartKey !== cartKey(customer.cart);
    const wishChanged = nextWishKey !== wishlistKey(customer.wishlist);
    await this.prisma.customer.update({
      where: { id: customer.id },
      data: {
        cart,
        wishlist,
        ...(cartChanged || (nextCartKey && !customer.cartUpdatedAt)
          ? { cartUpdatedAt: nextCartKey ? new Date() : null, cartRemindedKey: cartChanged ? "" : customer.cartRemindedKey }
          : {}),
        ...(wishChanged || (nextWishKey && !customer.wishlistUpdatedAt)
          ? { wishlistUpdatedAt: nextWishKey ? new Date() : null, wishlistRemindedKey: wishChanged ? "" : customer.wishlistRemindedKey }
          : {}),
      },
    });
    return { cart, wishlist };
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

  private async forgotByPhone(raw: string) {
    const phone = nationalMobile(raw);
    if (!phone) throw new BadRequestException("Enter a 10-digit mobile number.");
    const matches = await this.prisma.customer.findMany({ where: { phone } });
    if (matches.length > 1) throw new BadRequestException("That mobile is on more than one account. Use the email link.");
    if (matches.length === 0) return { ok: true };
    const customer = matches[0];
    await this.prisma.passwordReset.deleteMany({ where: { email: customer.email, purpose: "reset", usedAt: null } });
    const code = await this.saveCode(customer.email, "reset");
    const result = await this.whatsapp.passwordCode(phone, code);
    return { ok: true, previewCode: result.skipped ? code : undefined };
  }

  private async saveCode(email: string, purpose: "reset" | "login") {
    for (let tryNumber = 0; tryNumber < 5; tryNumber += 1) {
      const code = String(randomInt(0, 1000000)).padStart(6, "0");
      const tokenHash = hashToken(code);
      const existing = await this.prisma.passwordReset.findUnique({ where: { tokenHash } });
      if (existing && !existing.usedAt) continue;
      if (existing) await this.prisma.passwordReset.delete({ where: { id: existing.id } });
      await this.prisma.passwordReset.create({
        data: { email, purpose, tokenHash, expiresAt: new Date(Date.now() + CODE_MINUTES * 60 * 1000) },
      });
      return code;
    }
    throw new BadRequestException("Could not send a code. Try again.");
  }

  private async resetWithCode(rawPhone: string, rawCode: string | undefined, password: string) {
    const phone = nationalMobile(rawPhone);
    if (!phone) throw new BadRequestException("That code is not valid. Request a new one.");
    const matches = await this.prisma.customer.findMany({ where: { phone } });
    if (matches.length !== 1) throw new BadRequestException("That code is not valid. Request a new one.");
    const row = await this.matchCode(matches[0].email, "reset", rawCode);
    await this.prisma.customer.update({ where: { email: row.email }, data: { passwordHash: await hash(password, 10) } });
    return { ok: true };
  }

  private async matchCode(email: string, purpose: "reset" | "login", rawCode: string | undefined) {
    const code = (rawCode || "").replace(/\D/g, "");
    if (!/^\d{6}$/.test(code)) throw new BadRequestException("That code is not valid. Request a new one.");
    const row = await this.prisma.passwordReset.findFirst({
      where: { email, purpose, usedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw new BadRequestException("That code is not valid. Request a new one.");
    if (row.expiresAt.getTime() < Date.now() || row.attempts >= CODE_ATTEMPTS) {
      throw new BadRequestException("That code has expired. Request a new one.");
    }
    if (!sameHash(hashToken(code), row.tokenHash)) {
      const attempts = row.attempts + 1;
      await this.prisma.passwordReset.update({
        where: { id: row.id },
        data: { attempts, usedAt: attempts >= CODE_ATTEMPTS ? new Date() : null },
      });
      throw new BadRequestException("That code is not valid. Request a new one.");
    }
    await this.prisma.passwordReset.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    return row;
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

function nationalMobile(raw: string) {
  const digits = raw.replace(/\D/g, "");
  if (/^\d{10}$/.test(digits)) return digits;
  if (/^0\d{10}$/.test(digits)) return digits.slice(1);
  if (/^91\d{10}$/.test(digits)) return digits.slice(2);
  return null;
}

function sameHash(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
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
