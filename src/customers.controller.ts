import { randomInt, randomUUID, timingSafeEqual } from "crypto";
import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Req, UnauthorizedException } from "@nestjs/common";
import { hash, compare } from "bcryptjs";
import type { Request } from "express";
import { actorFrom, customerFrom, signToken } from "./auth";
import { hashToken, MailService } from "./mail.service";
import { PrismaService } from "./prisma.service";
import { cartKey, wishlistKey } from "./nudges.service";
import { cleanAddress } from "./delivery";
import { RateLimit } from "./rate-limit";
import { WhatsAppService } from "./whatsapp.service";

const CODE_MINUTES = 10;

// Each code costs a WhatsApp message and gives a guesser five more tries, so requests are limited per mobile and per visitor.
const codesPerMobile = new RateLimit(3, 15 * 60 * 1000, "Too many codes for this mobile. Wait 15 minutes, then ask again.");
const codesPerVisitor = new RateLimit(10, 10 * 60 * 1000, "Too many code requests. Wait a few minutes and try again.");
const guessesPerVisitor = new RateLimit(20, 10 * 60 * 1000, "Too many tries. Wait a few minutes and try again.");

/**
 * Only when MESSAGES_DEMO=true, and only while email or WhatsApp is not set up, a sign-in code or reset link
 * is shown on screen instead of being sent. Off by default: showing it would let anyone take over any account.
 */
function messagesDemo() {
  return process.env.MESSAGES_DEMO?.trim().toLowerCase() === "true";
}
const CODE_ATTEMPTS = 5;

@Controller("customers")
export class CustomersController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(WhatsAppService) private readonly whatsapp: WhatsAppService,
  ) {}

  @Post("register")
  async register(@Body() body: { name: string; email: string; phone: string; password: string; whatsappOptIn?: boolean }) {
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
        // Reminders are marketing messages, so they need the customer's own tick.
        whatsappOptIn: body.whatsappOptIn === true,
        whatsappOptInAt: body.whatsappOptIn === true ? new Date() : null,
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
  async loginCode(@Req() req: Request, @Body() body: { phone?: string }) {
    const phone = nationalMobile(body.phone || "");
    if (!phone) throw new BadRequestException("Enter a 10-digit mobile number.");
    this.requireCodeDelivery("Sign-in by WhatsApp code is not available yet. Sign in with your email and password.");
    codesPerVisitor.take(req.ip || "unknown");
    codesPerMobile.take(`login:${phone}`);
    // The same answer whether or not the mobile has an account, so mobiles cannot be checked one by one.
    const matches = await this.prisma.customer.findMany({ where: { phone } });
    const customer = matches.length === 1 && !matches[0].blocked ? matches[0] : null;
    if (!customer) return { ok: true };
    await this.prisma.passwordReset.deleteMany({ where: { email: customer.email, purpose: "login", usedAt: null } });
    const code = await this.saveCode(customer.email, "login");
    const result = await this.whatsapp.signInCode(phone, code);
    return { ok: true, previewCode: result.skipped && messagesDemo() ? code : undefined };
  }

  @Post("login-code/verify")
  async loginWithCode(@Req() req: Request, @Body() body: { phone?: string; code?: string }) {
    guessesPerVisitor.take(req.ip || "unknown");
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
  async forgot(@Req() req: Request, @Body() body: { email?: string; phone?: string }) {
    codesPerVisitor.take(req.ip || "unknown");
    if (body.phone?.trim()) return this.forgotByPhone(body.phone);
    const email = body.email?.trim().toLowerCase();
    if (!email) return { ok: true };
    codesPerMobile.take(`reset-email:${email}`);
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (!customer) return { ok: true };
    if (!this.mail.configured() && !messagesDemo()) {
      console.warn(`[mail] A password reset was asked for ${email}, but email is not set up, so no link was sent.`);
      return { ok: true };
    }
    const reset = this.mail.newResetToken();
    await this.prisma.passwordReset.deleteMany({ where: { email, purpose: "reset", usedAt: null } });
    await this.prisma.passwordReset.create({ data: { email, tokenHash: reset.tokenHash, expiresAt: reset.expiresAt } });
    const url = `${this.mail.appUrl()}/reset-password?token=${reset.token}`;
    const result = await this.mail.passwordReset(email, url);
    return { ok: true, previewUrl: result.skipped && messagesDemo() ? url : undefined };
  }

  @Post("reset-password")
  async reset(@Req() req: Request, @Body() body: { token?: string; phone?: string; code?: string; password: string }) {
    guessesPerVisitor.take(req.ip || "unknown");
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
  async updateMe(@Req() req: Request, @Body() body: { name?: string; phone?: string; whatsappOptIn?: boolean }) {
    const customer = await this.requireCustomer(req);
    const optIn = typeof body.whatsappOptIn === "boolean" ? body.whatsappOptIn : customer.whatsappOptIn;
    const updated = await this.prisma.customer.update({
      where: { id: customer.id },
      data: {
        name: body.name ?? customer.name,
        phone: body.phone ?? customer.phone,
        whatsappOptIn: optIn,
        whatsappOptInAt: optIn ? (customer.whatsappOptIn ? customer.whatsappOptInAt : new Date()) : null,
      },
    });
    return publicCustomer(updated);
  }

  @Post("me/addresses")
  async saveAddress(@Req() req: Request, @Body() body: { id: string; isDefault?: boolean; state?: unknown; pin?: unknown }) {
    const customer = await this.requireCustomer(req);
    // Saved addresses are cleaned and checked like checkout ones, except that a state the studio
    // does not deliver to yet can still be saved.
    const address = { ...cleanAddress(body), id: String(body.id ?? "").slice(0, 60) || `addr-${Date.now()}` };
    const current = (customer.addresses as { id: string; isDefault?: boolean }[]) ?? [];
    if (!current.some((entry) => entry.id === address.id) && current.length >= 20) {
      throw new BadRequestException("The address book holds 20 addresses. Remove one to add another.");
    }
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
    this.requireCodeDelivery("Resetting by WhatsApp code is not available yet. Use the email link instead.");
    codesPerMobile.take(`reset:${phone}`);
    const matches = await this.prisma.customer.findMany({ where: { phone } });
    if (matches.length !== 1) return { ok: true };
    const customer = matches[0];
    await this.prisma.passwordReset.deleteMany({ where: { email: customer.email, purpose: "reset", usedAt: null } });
    const code = await this.saveCode(customer.email, "reset");
    const result = await this.whatsapp.passwordCode(phone, code);
    return { ok: true, previewCode: result.skipped && messagesDemo() ? code : undefined };
  }

  /** Codes go out by WhatsApp; without it they can only be shown on screen in demo mode. */
  private requireCodeDelivery(message: string) {
    if (!this.whatsapp.configured() && !messagesDemo()) throw new BadRequestException(message);
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

export function publicCustomer(customer: { id: string; name: string; email: string; phone: string; blocked: boolean; addresses: unknown; whatsappOptIn?: boolean }) {
  return {
    whatsappOptIn: customer.whatsappOptIn ?? false,
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    blocked: customer.blocked,
    addresses: customer.addresses,
  };
}
