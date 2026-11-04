import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Req, UnauthorizedException, Query } from "@nestjs/common";
import { compare, hash } from "bcryptjs";
import type { Request } from "express";
import { actorFrom, customerFrom, signToken, requireOwner } from "./auth";
import { categorySlug } from "./category-slug";
import { presentAudience } from "./audiences";
import { canonicalState } from "./delivery";
import { presentProduct } from "./catalog.controller";
import { publicCustomer } from "./customers.controller";
import { OrdersService } from "./orders.service";
import { PrismaService } from "./prisma.service";

@Controller()
export class StudioController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  /**
   * For uptime pingers. Plain /health never touches the database. /health?db=1 also runs one tiny query,
   * which keeps a free, sleep-when-idle database awake (one database operation per ping).
   */
  @Get("health")
  async health(@Query("db") db?: string) {
    if (db === "1") await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true, service: "earthen-api" };
  }

  @Get("bootstrap")
  async bootstrap(@Req() req: Request) {
    const staff = actorFrom(req);
    const customer = customerFrom(req);
    const [products, coupons, banners, setting, sequence, categories, audiences, fabrics, styles] = await Promise.all([
      this.prisma.product.findMany({ orderBy: { name: "asc" } }),
      this.prisma.coupon.findMany({ orderBy: { code: "asc" } }),
      this.prisma.banner.findMany(),
      this.prisma.setting.findUnique({ where: { id: "store" } }),
      this.prisma.sequence.findUnique({ where: { id: "order" } }),
      this.prisma.category.findMany({ orderBy: [{ sort: "asc" }, { label: "asc" }] }),
      this.prisma.audience.findMany({ orderBy: [{ sort: "asc" }, { label: "asc" }] }),
      this.prisma.fabric.findMany({ orderBy: { label: "asc" } }),
      this.prisma.style.findMany({ orderBy: [{ sort: "asc" }, { label: "asc" }] }),
    ]);
    const isStaff = staff?.kind === "staff";
    // Shoppers never receive drafts or archived pieces; staff need them for the admin.
    const off = new Set(audiences.filter((row) => !row.active).map((row) => row.slug));
    const presented = products.filter((product) => isStaff || (product.status === "active" && !off.has(product.gender))).map(presentProduct);
    const orders = isStaff
      ? await this.prisma.order.findMany({ orderBy: { createdAt: "desc" } })
      : customer
        ? await this.prisma.order.findMany({ where: { email: customer.email }, orderBy: { createdAt: "desc" } })
        : [];
    const customers = isStaff ? await this.prisma.customer.findMany({ orderBy: { createdAt: "asc" } }) : [];
    const staffList = isStaff ? await this.prisma.staff.findMany({ orderBy: { name: "asc" } }) : [];
    const me = customer ? await this.prisma.customer.findUnique({ where: { email: customer.email } }) : null;
    return {
      overrides: Object.fromEntries(presented.map((entry) => [entry.product.slug, entry.override])),
      coupons,
      settings: setting?.data ?? {},
      banners,
      nextNumber: (sequence?.value ?? 10423) + 1,
      orders: orders.map((order) => this.orders.present(order)),
      accounts: customers.map(publicCustomer),
      blockedEmails: customers.filter((entry) => entry.blocked).map((entry) => entry.email),
      staffList: staffList.map((member) => ({ id: member.id, name: member.name, email: member.email, role: member.role, password: "" })),
      user: me ? publicCustomer(me) : null,
      products: presented.map((entry) => entry.product),
      categories: categories.map((category) => ({
        slug: category.slug,
        label: category.label,
        blurb: category.blurb,
        image: category.image,
        chart: category.chart === "lower" ? "lower" : "upper",
        sort: category.sort,
      })),
      // Shoppers get only switched-on audiences; staff need all of them to prepare products.
      fabrics,
      // Switched-off styles stay out of shoppers' filters.
      styles: styles.filter((row) => isStaff || row.active),
      audiences: audiences.filter((row) => isStaff || row.active).map(presentAudience),
      bag: me ? { cart: me.cart ?? [], wishlist: me.wishlist ?? [] } : null,
    };
  }

  @Post("staff/login")
  async login(@Body() body: { email: string; password: string }) {
    const email = body.email.trim().toLowerCase();
    const member = await this.prisma.staff.findUnique({ where: { email } });
    if (!member || !(await compare(body.password, member.passwordHash))) {
      throw new BadRequestException("Email or password is incorrect.");
    }
    return {
      token: signToken({ kind: "staff", email, role: member.role }),
      staff: { id: member.id, name: member.name, email: member.email, role: member.role, password: "" },
    };
  }

  @Get("staff")
  async listStaff(@Req() req: Request) {
    this.requireStaff(req);
    const staff = await this.prisma.staff.findMany({ orderBy: { name: "asc" } });
    return staff.map((member) => ({ id: member.id, name: member.name, email: member.email, role: member.role }));
  }

  @Post("staff")
  async invite(@Req() req: Request, @Body() body: { name: string; email: string; role: string }) {
    const actor = this.requireStaff(req);
    if (actor.role !== "Owner") throw new BadRequestException("Only the owner can invite staff.");
    const email = body.email.trim().toLowerCase();
    const existing = await this.prisma.staff.findUnique({ where: { email } });
    if (existing) throw new BadRequestException("That person already has access.");
    const member = await this.prisma.staff.create({
      data: { id: `staff-${Date.now()}`, name: body.name, email, role: body.role, passwordHash: await hash("studio", 10) },
    });
    return { id: member.id, name: member.name, email: member.email, role: member.role, password: "studio" };
  }

  @Get("settings")
  settings() {
    return this.orders.settings();
  }

  @Put("settings")
  async saveSettings(@Req() req: Request, @Body() body: Record<string, unknown>) {
    // Shipping, payments, delivery areas: the owner's to change, as on the admin Settings page.
    await requireOwner(req, this.prisma, "change store settings");
    const current = await this.orders.settings();
    const next = { ...current, ...body };
    // Delivery areas: only real state and UT names, written the official way.
    if (body.disabledStates !== undefined) {
      const list = Array.isArray(body.disabledStates) ? body.disabledStates : [];
      const named = list.map(canonicalState);
      if (named.some((state) => !state)) throw new BadRequestException("Delivery areas must be Indian states or union territories.");
      next.disabledStates = [...new Set(named as string[])];
    }
    const saved = await this.prisma.setting.upsert({
      where: { id: "store" },
      create: { id: "store", data: next as object },
      update: { data: next as object },
    });
    return saved.data;
  }

  @Get("coupons")
  coupons() {
    return this.prisma.coupon.findMany({ orderBy: { code: "asc" } });
  }

  @Put("coupons/:code")
  async saveCoupon(@Req() req: Request, @Param("code") code: string, @Body() body: Record<string, unknown>) {
    this.requireStaff(req);
    const normalized = code.trim().toUpperCase();
    if (!normalized) throw new BadRequestException("Add a code.");
    return this.prisma.coupon.upsert({
      where: { code: normalized },
      create: {
        code: normalized,
        type: String(body.type ?? "percent"),
        value: Number(body.value ?? 0),
        minOrder: Number(body.minOrder ?? 0),
        usageLimit: Number(body.usageLimit ?? 0),
        used: Number(body.used ?? 0),
        starts: String(body.starts ?? ""),
        ends: String(body.ends ?? ""),
        active: body.active !== false,
      },
      update: {
        type: String(body.type ?? "percent"),
        value: Number(body.value ?? 0),
        minOrder: Number(body.minOrder ?? 0),
        usageLimit: Number(body.usageLimit ?? 0),
        starts: String(body.starts ?? ""),
        ends: String(body.ends ?? ""),
        active: body.active !== false,
      },
    });
  }

  @Delete("coupons/:code")
  async removeCoupon(@Req() req: Request, @Param("code") code: string) {
    this.requireStaff(req);
    await this.prisma.coupon.delete({ where: { code: code.toUpperCase() } });
    return { ok: true };
  }

  @Get("banners")
  banners() {
    return this.prisma.banner.findMany();
  }

  @Put("banners/:id")
  async saveBanner(@Req() req: Request, @Param("id") id: string, @Body() body: { title: string; subtitle?: string; href?: string; starts?: string; ends?: string }) {
    this.requireStaff(req);
    return this.prisma.banner.upsert({
      where: { id },
      create: { id, title: body.title, subtitle: body.subtitle ?? "", href: body.href ?? "/shop", starts: body.starts ?? "", ends: body.ends ?? "" },
      update: { title: body.title, subtitle: body.subtitle ?? "", href: body.href ?? "/shop", starts: body.starts ?? "", ends: body.ends ?? "" },
    });
  }

  @Post("categories")
  async createCategory(@Req() req: Request, @Body() body: { label?: string; blurb?: string; image?: string; chart?: string }) {
    this.requireStaff(req);
    const label = (body.label ?? "").trim().replace(/\s+/g, " ");
    const slug = categorySlug(label);
    if (!slug || slug === "new" || slug === "all") throw new BadRequestException("Choose another name. New in stays a shop filter.");
    const existing = await this.prisma.category.findUnique({ where: { slug } });
    if (existing) throw new BadRequestException("A category with that name already exists.");
    const sort = ((await this.prisma.category.aggregate({ _max: { sort: true } }))._max.sort ?? -1) + 1;
    return this.prisma.category.create({
      data: {
        slug,
        label,
        blurb: (body.blurb ?? "").trim(),
        image: (body.image ?? "").trim(),
        chart: body.chart === "lower" ? "lower" : "upper",
        sort,
      },
    });
  }

  // Saves the menu order: the drawer, footer, and shop tabs list categories in this order.
  @Put("categories/order")
  async orderCategories(@Req() req: Request, @Body() body: { slugs?: unknown }) {
    this.requireStaff(req);
    const slugs = Array.isArray(body.slugs) ? body.slugs.map(String) : [];
    const existing = await this.prisma.category.findMany({ select: { slug: true } });
    const known = new Set(existing.map((row) => row.slug));
    if (slugs.length !== known.size || new Set(slugs).size !== slugs.length || !slugs.every((slug) => known.has(slug))) {
      throw new BadRequestException("The list changed while you were ordering it. Reload the page and try again.");
    }
    await this.prisma.$transaction(slugs.map((slug, sort) => this.prisma.category.update({ where: { slug }, data: { sort } })));
    return { ok: true };
  }

  @Patch("categories/:slug")
  async updateCategory(@Req() req: Request, @Param("slug") slug: string, @Body() body: { label?: string; blurb?: string; image?: string; chart?: string }) {
    this.requireStaff(req);
    const existing = await this.prisma.category.findUnique({ where: { slug } });
    if (!existing) throw new BadRequestException("Category not found.");
    const label = (body.label ?? existing.label).trim().replace(/\s+/g, " ");
    if (!label) throw new BadRequestException("A category needs a name.");
    return this.prisma.category.update({
      where: { slug },
      data: {
        label,
        blurb: body.blurb === undefined ? existing.blurb : body.blurb.trim(),
        image: body.image === undefined ? existing.image : body.image.trim(),
        chart: body.chart === undefined ? existing.chart : body.chart === "lower" ? "lower" : "upper",
      },
    });
  }

  @Delete("categories/:slug")
  async removeCategory(@Req() req: Request, @Param("slug") slug: string) {
    this.requireStaff(req);
    const used = await this.prisma.product.count({ where: { category: slug } });
    if (used > 0) throw new BadRequestException(`${used} products still use this category. Move them first.`);
    await this.prisma.category.delete({ where: { slug } });
    return { ok: true };
  }

  @Delete("banners/:id")
  async removeBanner(@Req() req: Request, @Param("id") id: string) {
    this.requireStaff(req);
    await this.prisma.banner.delete({ where: { id } });
    return { ok: true };
  }

  private requireStaff(req: Request) {
    const actor = actorFrom(req);
    if (!actor || actor.kind !== "staff") throw new UnauthorizedException("Staff sign-in is required.");
    return actor;
  }
}
