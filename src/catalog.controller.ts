import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Query, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { categorySlug } from "./category-slug";
import { audienceMatcher, isOnSale, onSaleWhere, requireSizes, resolveAudience } from "./audiences";
import { customerFrom, isStaff, requireCatalogStaff } from "./auth";
import { cleanDetail, resolveFabric, splitFabric } from "./fabrics";
import { resolveStyles } from "./styles";
import { MailService } from "./mail.service";
import { PrismaService } from "./prisma.service";

@Controller("catalog")
export class CatalogController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  @Get()
  async list(@Req() req: Request, @Query("gender") gender?: string | string[], @Query("style") style?: string | string[]) {
    const selected = (Array.isArray(gender) ? gender : gender ? [gender] : []).flatMap((item) => item.split(",")).map((item) => item.trim().toLowerCase()).filter(Boolean);
    // Shoppers only see what is on sale; staff also see drafts and archived pieces.
    const products = await this.prisma.product.findMany({ where: isStaff(req) ? {} : await onSaleWhere(this.prisma), orderBy: { name: "asc" } });
    const matches = audienceMatcher(await this.prisma.audience.findMany(), selected);
    const styles = (Array.isArray(style) ? style : style ? [style] : []).flatMap((item) => item.split(",")).map((item) => item.trim().toLowerCase()).filter(Boolean);
    return products
      .filter((product) => matches(product.gender) && (!styles.length || product.styles.some((slug) => styles.includes(slug))))
      .map(presentProduct);
  }

  @Post()
  async create(@Req() req: Request, @Body() body: CreateBody) {
    await requireCatalogStaff(req, this.prisma);
    return this.presentSaved(await this.insertProduct(body));
  }

  @Post("import")
  async import(@Req() req: Request, @Body() body: { rows?: Record<string, string>[] }) {
    await requireCatalogStaff(req, this.prisma);
    const rows = body.rows ?? [];
    let created = 0;
    let updated = 0;
    // Each row stands alone: a bad row is reported and skipped, the rest still import.
    const skipped: string[] = [];
    for (const [index, row] of rows.entries()) {
      try {
        const name = (row.name ?? "").trim();
        if (!name) continue;
        const slug = slugify(row.slug || name);
        const existing = await this.prisma.product.findUnique({ where: { slug } });
        const statusText = (row.status ?? "").trim().toLowerCase();
        const status = ["active", "draft", "archived"].includes(statusText) ? statusText : undefined;
        const price = Number(row.price);
        if (!existing) {
          await this.insertProduct(
            {
            name,
            slug,
            price: Number.isFinite(price) && price > 0 ? price : 1999,
            category: row.category,
            gender: row.gender,
            fabric: row.fabric,
            color: row.color,
            hex: row.hex,
            silhouette: row.silhouette,
            status: status ?? "active",
            stockEach: stockEach(row.stock),
            styles: row.styles,
            },
            { newFabrics: true },
          );
          created += 1;
          continue;
        }
        await this.prisma.product.update({
          where: { slug },
          data: {
            name,
            price: Number.isFinite(price) && price > 0 ? price : existing.price,
            category: row.category?.trim() ? await this.ensureCategory(row.category) : existing.category,
            ...(row.gender?.trim() ? { gender: (await resolveAudience(this.prisma, row.gender)).slug } : {}),
            ...(row.fabric?.trim() ? await this.fabricFields(row.fabric, undefined, true) : {}),
            ...(row.styles?.trim() ? { styles: await resolveStyles(this.prisma, row.styles, true) } : {}),
            status: status ?? existing.status,
          },
        });
        updated += 1;
      } catch (error) {
        const label = (row.name ?? "").trim() || `row ${index + 2}`;
        skipped.push(`${label} (row ${index + 2}): ${error instanceof Error ? error.message : "could not be saved"}`);
      }
    }
    return { created, updated, skipped };
  }

  @Get(":slug/review")
  async reviewGate(@Req() req: Request, @Param("slug") slug: string) {
    const customer = await this.requireCustomer(req);
    const product = await this.prisma.product.findUnique({ where: { slug } });
    if (!product) throw new BadRequestException("Product not found.");
    const purchase = await this.purchaseOf(customer.id, customer.email, slug);
    const reviews = storedReviews(product.reviews);
    const mine = reviews.find((review) => review.email === customer.email.toLowerCase());
    return {
      eligible: Boolean(purchase?.received),
      waiting: Boolean(purchase && !purchase.received),
      size: purchase?.size ?? null,
      color: purchase?.color ?? null,
      review: mine
        ? { rating: mine.rating, text: mine.text, fit: mine.fit, heightCm: mine.heightCm || null }
        : null,
    };
  }

  @Post(":slug/reviews")
  async review(@Req() req: Request, @Param("slug") slug: string, @Body() body: ReviewBody) {
    const customer = await this.requireCustomer(req);
    const product = await this.prisma.product.findUnique({ where: { slug } });
    if (!product) throw new BadRequestException("Product not found.");
    const purchase = await this.purchaseOf(customer.id, customer.email, slug);
    if (!purchase?.received) {
      throw new ForbiddenException(purchase ? "You can review this piece after it is delivered." : "Reviews are open to customers who bought this piece.");
    }
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new BadRequestException("Choose a rating from 1 to 5.");
    const text = (body.text ?? "").trim().replace(/\s+/g, " ");
    if (text.length < 8 || text.length > 400) throw new BadRequestException("Write a short review, between 8 and 400 characters.");
    const fit = body.fit?.trim();
    if (!fit || !FITS.includes(fit)) throw new BadRequestException("Say how the size felt.");
    const height = body.heightCm === undefined || body.heightCm === null || body.heightCm === "" ? 0 : Number(body.heightCm);
    if (!Number.isInteger(height) || (height !== 0 && (height < 120 || height > 220))) {
      throw new BadRequestException("Height should be in centimetres, between 120 and 220.");
    }
    const email = customer.email.toLowerCase();
    const reviews = storedReviews(product.reviews);
    const previous = reviews.find((review) => review.email === email);
    const nextReview: StoredReview = {
      name: customer.name.trim().split(/\s+/)[0] || "Customer",
      rating,
      text,
      size: purchase.size,
      fit,
      heightCm: height,
      color: purchase.color,
      email,
    };
    const next = previous ? reviews.map((review) => (review.email === email ? nextReview : review)) : [...reviews, nextReview];
    const stats = nextStats(product.rating, product.reviewCount, previous?.rating ?? null, rating);
    const updated = await this.prisma.product.update({
      where: { slug },
      data: { reviews: next, rating: stats.rating, reviewCount: stats.reviewCount },
    });
    return presentProduct(updated);
  }

  @Get(":slug")
  async one(@Req() req: Request, @Param("slug") slug: string) {
    const product = await this.prisma.product.findUnique({ where: { slug } });
    if (!product || (!isStaff(req) && !(await isOnSale(this.prisma, product)))) throw new NotFoundException("Product not found.");
    return presentProduct(product);
  }

  @Patch(":slug")
  async update(@Req() req: Request, @Param("slug") slug: string, @Body() body: Record<string, unknown>) {
    await requireCatalogStaff(req, this.prisma);
    const product = await this.prisma.product.findUnique({ where: { slug } });
    if (!product) throw new BadRequestException("Product not found.");
    const nextStock = body.stock === undefined ? undefined : cleanStock(body.stock);
    const stockBase = body.stock !== undefined && body.stockBase !== undefined ? cleanStock(body.stockBase) : undefined;
    const price = body.price === undefined ? product.price : Number(body.price);
    if (!Number.isFinite(price) || price <= 0) throw new BadRequestException("Enter a price above zero in rupees.");
    const salePrice = body.salePrice === undefined ? product.salePrice : body.salePrice === null || body.salePrice === "" ? null : Number(body.salePrice);
    if (salePrice !== null && (!Number.isFinite(salePrice) || salePrice <= 0 || Math.round(salePrice) >= Math.round(price))) {
      throw new BadRequestException("A sale price must be above zero and below the regular price.");
    }
    const saleStart = stringOr(body.saleStart, product.saleStart);
    const saleEnd = stringOr(body.saleEnd, product.saleEnd);
    if ([saleStart, saleEnd].some((day) => day && !/^\d{4}-\d{2}-\d{2}$/.test(day))) throw new BadRequestException("Sale dates must be real dates.");
    if (saleStart && saleEnd && saleEnd < saleStart) throw new BadRequestException("The sale cannot end before it starts.");
    const status = body.status === undefined ? product.status : String(body.status);
    if (!["active", "draft", "archived"].includes(status)) throw new BadRequestException("Status must be active, draft, or archived.");
    const data = {
        price: Math.round(price),
        salePrice: salePrice === null ? null : Math.round(salePrice),
        saleStart,
        saleEnd,
        status,
        ...(typeof body.gender === "string" && body.gender.trim() ? { gender: (await resolveAudience(this.prisma, body.gender)).slug } : {}),
        ...(body.sizes !== undefined ? { sizes: requireSizes(body.sizes) } : {}),
        ...(typeof body.isNew === "boolean" ? { isNew: body.isNew } : {}),
        ...(body.styles !== undefined ? { styles: await resolveStyles(this.prisma, body.styles) } : {}),
        ...(typeof body.category === "string" && body.category.trim() ? { category: await this.ensureCategory(body.category) } : {}),
        metaTitle: stringOr(body.metaTitle, product.metaTitle),
        metaDescription: stringOr(body.metaDescription, product.metaDescription),
        ...(typeof body.name === "string" && body.name.trim() ? { name: body.name.trim().replace(/\s+/g, " ").slice(0, 80) } : {}),
        ...(typeof body.description === "string" ? { description: body.description.trim().slice(0, 800) } : {}),
        ...(typeof body.fabric === "string" && body.fabric.trim() ? await this.fabricFields(body.fabric, body.fabricDetail) : {}),
        ...(typeof body.fabric !== "string" && typeof body.fabricDetail === "string" ? { fabricDetail: cleanDetail(body.fabricDetail) } : {}),
        ...(Array.isArray(body.care) ? { care: cleanLines(body.care) } : {}),
        ...(cleanColors(body.colors).length ? { colors: cleanColors(body.colors) } : {}),
        ...(Array.isArray(body.photos) ? { photos: cleanPhotos(body.photos) } : {}),
    };
    // Stock is written only when the editor changed it, with the row locked, so an order placed meanwhile is never undone.
    const updated = await this.prisma.$transaction(async (tx) => {
      if (!nextStock) return tx.product.update({ where: { slug }, data });
      await tx.$queryRaw`SELECT slug FROM "Product" WHERE slug = ${slug} FOR UPDATE`;
      const current = await tx.product.findUnique({ where: { slug }, select: { stock: true } });
      // The editor sends the stock it started from; if orders or returns moved it since, saving would undo them.
      if (stockBase && !sameStock(stockBase, (current?.stock ?? {}) as Record<string, number>)) {
        throw new ConflictException("Stock changed while you were editing, most likely from a new order. Reload the page to see the latest numbers, then make your change again.");
      }
      return tx.product.update({ where: { slug }, data: { ...data, stock: nextStock } });
    });
    await this.sendRestockMail(product.name, slug, updated.stock as Record<string, number>);
    return this.presentSaved(updated);
  }

  @Delete(":slug")
  async remove(@Req() req: Request, @Param("slug") slug: string) {
    await requireCatalogStaff(req, this.prisma);
    const product = await this.prisma.product.findUnique({ where: { slug } });
    if (!product) throw new BadRequestException("Product not found.");
    const orders = await this.prisma.order.findMany();
    const hasOrder = orders.some((order) => {
      const items = order.items as Array<{ slug?: string }>;
      return Array.isArray(items) && items.some((item) => item.slug === slug);
    });
    if (hasOrder) {
      throw new BadRequestException("This product has existing customer orders and cannot be deleted. Change its status to Archived instead.");
    }
    await this.prisma.restockAlert.deleteMany({ where: { slug } });
    await this.prisma.product.delete({ where: { slug } });
    return { ok: true };
  }

  @Post(":slug/restock")
  async restock(@Param("slug") slug: string, @Body() body: { color?: string; size?: string; contact?: string }) {
    const product = await this.prisma.product.findUnique({ where: { slug } });
    if (!product || !(await isOnSale(this.prisma, product))) throw new BadRequestException("This piece is not in the shop.");
    const color = (body.color ?? "").trim();
    const size = (body.size ?? "").trim();
    const contact = (body.contact ?? "").trim();
    const isEmail = contact.includes("@") && contact.includes(".");
    const isMobile = /^\d{10}$/.test(contact);
    if (!color || !size || (!isEmail && !isMobile)) {
      throw new BadRequestException("Enter an email address or a 10-digit mobile number.");
    }
    const stock = product.stock as Record<string, number>;
    if ((stock[`${color}|${size}`] ?? 0) > 0) throw new BadRequestException("That size is in stock.");
    await this.prisma.restockAlert.upsert({
      where: { slug_color_size_contact: { slug, color, size, contact } },
      create: { slug, color, size, contact },
      update: { emailedAt: null },
    });
    if (isEmail) await this.mail.restockNoted(contact, product.name, color, size);
    return { message: `We'll write to ${contact} when ${color} in ${size} is back.` };
  }

  private async sendRestockMail(name: string, slug: string, stock: Record<string, number>) {
    const waiting = await this.prisma.restockAlert.findMany({ where: { slug, emailedAt: null } });
    for (const alert of waiting) {
      if (!alert.contact.includes("@") || (stock[`${alert.color}|${alert.size}`] ?? 0) <= 0) continue;
      const result = await this.mail.restockBack(alert.contact, name, alert.color, alert.size, `${this.mail.appUrl()}/product/${slug}`);
      if (result.sent) await this.prisma.restockAlert.update({ where: { id: alert.id }, data: { emailedAt: new Date() } });
    }
  }

  private async requireCustomer(req: Request) {
    const actor = customerFrom(req);
    if (!actor || actor.kind !== "customer") throw new UnauthorizedException("Sign in to review a piece you have received.");
    const customer = await this.prisma.customer.findUnique({ where: { email: actor.email } });
    if (!customer) throw new UnauthorizedException("Sign in to review a piece you have received.");
    if (customer.blocked) throw new ForbiddenException("This account is blocked. Write to the studio if this is a mistake.");
    return customer;
  }

  private async purchaseOf(customerId: string, email: string, slug: string) {
    const orders = await this.prisma.order.findMany({
      where: { OR: [{ customerId }, { email }] },
      orderBy: { createdAt: "desc" },
    });
    let waiting: { size: string; color: string } | null = null;
    for (const order of orders) {
      if (order.status === "Cancelled") continue;
      const line = (order.items as { slug?: string; size?: string; color?: string }[]).find((item) => item.slug === slug && item.size && item.color);
      if (!line) continue;
      const bought = { size: line.size as string, color: line.color as string };
      if (RECEIVED.has(order.status)) return { ...bought, received: true };
      waiting ??= bought;
    }
    return waiting ? { ...waiting, received: false } : null;
  }

  private async ensureCategory(value?: string) {
    const raw = (value ?? "").trim();
    const slug = categorySlug(raw);
    if (!slug || slug === "new" || slug === "all") throw new BadRequestException("Choose a category name. New in stays a shop filter.");
    const existing = await this.prisma.category.findUnique({ where: { slug } });
    if (existing) return slug;
    const titled = slug
      .split("-")
      .filter(Boolean)
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(" ");
    const label = raw.toLowerCase() === slug || raw.toLowerCase().replace(/-/g, " ") === slug.replace(/-/g, " ") ? titled : raw.replace(/\s+/g, " ");
    const sort = ((await this.prisma.category.aggregate({ _max: { sort: true } }))._max.sort ?? -1) + 1;
    await this.prisma.category.create({
      data: { slug, label, chart: slug === "bottoms" ? "lower" : "upper", sort },
    });
    return slug;
  }

  private async presentSaved(product: Parameters<typeof presentProduct>[0]) {
    const category = await this.prisma.category.findUnique({ where: { slug: product.category } });
    return { ...presentProduct(product), category };
  }

  /** The fabric must be in the list (CSV import may add it). Without a separate detail, "Linen, 160 gsm" is split. */
  private async fabricFields(fabric: string, detail: unknown, newFabrics = false) {
    const parts = typeof detail === "string" ? { fabric, detail } : splitFabric(fabric);
    return { fabric: await resolveFabric(this.prisma, parts.fabric, newFabrics), fabricDetail: cleanDetail(parts.detail) };
  }

  private async insertProduct(body: CreateBody, options: { newFabrics?: boolean } = {}) {
    const name = body.name?.trim();
    if (!name) throw new BadRequestException("A product needs a name.");
    const slug = await this.uniqueSlug(slugify(body.slug || name));
    const colors = cleanColors(body.colors?.length ? body.colors : [{ name: body.color?.trim() || "Sand", hex: body.hex?.trim() || "#E4D7C4" }]);
    if (!colors.length) throw new BadRequestException("Add at least one colour.");
    const price = body.price === undefined || body.price === null ? 1999 : Number(body.price);
    if (!Number.isFinite(price) || price <= 0) throw new BadRequestException("Enter a price above zero in rupees.");
    // Refuse a bad audience, sizes, or fabric before anything (like a new category) is created.
    if (body.gender?.trim()) await resolveAudience(this.prisma, body.gender);
    if (body.sizes !== undefined) requireSizes(body.sizes);
    // Without a choice, a new product starts as Casual when that style exists.
    const styles =
      body.styles !== undefined && String(body.styles).trim() !== ""
        ? await resolveStyles(this.prisma, body.styles, options.newFabrics)
        : (await this.prisma.style.findUnique({ where: { slug: "casual" } }))
          ? ["casual"]
          : [];
    const fabric = body.fabric?.trim()
      ? await this.fabricFields(body.fabric, body.fabricDetail, options.newFabrics)
      : { fabric: await resolveFabric(this.prisma, "Cotton", true), fabricDetail: "" };
    const category = await this.ensureCategory(body.category);
    const silhouette = silhouetteOf(body.silhouette, category);
    const audience = await resolveAudience(this.prisma, body.gender, silhouette);
    // A new product takes its audience's sizes unless it brings its own.
    const sizes = body.sizes !== undefined ? requireSizes(body.sizes) : requireSizes(audience.sizes);
    const each = typeof body.stockEach === "number" && Number.isFinite(body.stockEach) && body.stockEach > 0 ? Math.min(Math.round(body.stockEach), 9999) : 0;
    const stock: Record<string, number> = {};
    for (const color of colors) {
      for (const size of sizes) stock[`${color.name}|${size}`] = each;
    }
    return this.prisma.product.create({
      data: {
        ...fabric,
        slug,
        name,
        price: Math.round(price),
        category,
        gender: audience.slug,
        styles,
        description: body.description?.trim() || `${name}. Cut and sewn in Bengaluru.`,
        details: ["Cut in Bengaluru"],
        care: ["Machine wash cold", "Hang dry in the shade"],
        rating: 0,
        reviewCount: 0,
        isNew: body.isNew ?? true,
        reviews: [],
        colors,
        sizes,
        stock,
        status: body.status === "draft" || body.status === "archived" ? body.status : "active",
        silhouette,
        origin: "Cut and sewn in Bengaluru",
        fit: "Fits true to size.",
        // Only adult pieces get the studio model line; it would be wrong for children's sizes.
        model: audience.group === "adults" ? { heightCm: 178, size: sizes.includes("M") ? "M" : sizes[0] } : { heightCm: 0, size: "" },
      },
    });
  }

  private async uniqueSlug(base: string) {
    let slug = base || "piece";
    let n = 2;
    while (await this.prisma.product.findUnique({ where: { slug } })) {
      slug = `${base}-${n}`;
      n += 1;
    }
    return slug;
  }
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

type CreateBody = {
  name: string;
  slug?: string;
  price?: number;
  category?: string;
  gender?: string;
  fabric?: string;
  fabricDetail?: string;
  description?: string;
  color?: string;
  hex?: string;
  colors?: { name: string; hex: string }[];
  silhouette?: string;
  status?: string;
  stockEach?: number;
  sizes?: unknown;
  isNew?: boolean;
  styles?: unknown;
};

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "piece";
}

function silhouetteOf(value: string | undefined, category: string) {
  const allowed = ["overshirt", "tee", "shirt", "trouser", "skirt", "cardigan", "jacket"];
  if (value && allowed.includes(value)) return value;
  if (category === "bottoms") return "trouser";
  if (category === "outerwear") return "jacket";
  return "tee";
}

function sameStock(left: Record<string, number>, right: Record<string, number>) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => (left[key] ?? 0) === (right[key] ?? 0));
}

function cleanStock(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException("Stock must list units for each colour and size.");
  const stock: Record<string, number> = {};
  for (const [key, units] of Object.entries(value as Record<string, unknown>)) {
    const count = Number(units);
    if (!key.includes("|") || !Number.isInteger(count) || count < 0) throw new BadRequestException("Stock must be whole numbers, zero or more.");
    stock[key] = Math.min(count, 9999);
  }
  return stock;
}

function cleanLines(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .slice(0, 12)
    .map((item) => item.slice(0, 160));
}

function cleanColors(value: unknown) {
  if (!Array.isArray(value)) return [];
  const colors: { name: string; hex: string }[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const name = String((item as { name?: string }).name ?? "").replace(/\|/g, "").trim().replace(/\s+/g, " ").slice(0, 40);
    const hex = String((item as { hex?: string }).hex ?? "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    colors.push({ name, hex: /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toUpperCase() : "#E4D7C4" });
    if (colors.length === 8) break;
  }
  return colors;
}

function cleanPhotos(value: unknown) {
  if (!Array.isArray(value)) return [];
  const photos: { id: string; label: string; src: string; alt: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const src = String((item as { src?: string }).src ?? "").trim();
    if (!isPhotoSrc(src)) continue;
    photos.push({
      id: String((item as { id?: string }).id ?? "").replace(/[^\w-]/g, "").slice(0, 40) || `photo-${photos.length + 1}`,
      label: String((item as { label?: string }).label ?? "Photo").trim().slice(0, 40) || "Photo",
      src,
      alt: String((item as { alt?: string }).alt ?? "").trim().slice(0, 180),
    });
    if (photos.length === 8) break;
  }
  return photos;
}

function stockEach(value?: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 9999) return undefined;
  return Math.round(parsed);
}

export function presentProduct(product: {
  slug: string;
  name: string;
  price: number;
  category: string;
  gender?: string;
  fabric: string;
  fabricDetail?: string;
  styles?: string[];
  description: string;
  details: unknown;
  care: unknown;
  rating: number;
  reviewCount: number;
  isNew: boolean;
  reviews: unknown;
  colors: unknown;
  sizes: unknown;
  stock: unknown;
  status: string;
  salePrice: number | null;
  saleStart: string;
  saleEnd: string;
  metaTitle: string;
  metaDescription: string;
  silhouette?: string;
  origin?: string;
  fit?: string;
  model?: unknown;
  photos?: unknown;
}) {
  return {
    product: {
      slug: product.slug,
      name: product.name,
      price: product.price,
      category: product.category,
      gender: product.gender || "unisex",
      fabric: product.fabric,
      fabricDetail: product.fabricDetail ?? "",
      styles: product.styles ?? [],
      description: product.description,
      details: product.details,
      care: product.care,
      rating: product.rating,
      reviewCount: product.reviewCount,
      isNew: product.isNew,
      reviews: publicReviews(product.reviews),
      colors: product.colors,
      sizes: product.sizes,
      stock: product.stock,
      silhouette: product.silhouette ?? "tee",
      origin: product.origin ?? "",
      fit: product.fit ?? "",
      model: product.model ?? { heightCm: 178, size: "M" },
      photos: cleanPhotos(product.photos),
    },
    override: {
      price: product.price,
      salePrice: product.salePrice,
      saleStart: product.saleStart,
      saleEnd: product.saleEnd,
      status: product.status,
      metaTitle: product.metaTitle,
      metaDescription: product.metaDescription,
      stock: product.stock,
    },
  };
}

const FITS = ["Runs small", "True to size", "Runs large"];
const RECEIVED = new Set(["Delivered", "Return requested", "Returned"]);

type ReviewBody = { rating?: number; text?: string; fit?: string; heightCm?: number | string | null };

type StoredReview = {
  name: string;
  rating: number;
  text: string;
  size: string;
  fit: string;
  heightCm: number;
  color: string;
  email?: string;
};

function storedReviews(value: unknown): StoredReview[] {
  if (!Array.isArray(value)) return [];
  return value.filter((review) => review && typeof review === "object") as StoredReview[];
}

function publicReviews(value: unknown) {
  return storedReviews(value).map(({ email: _email, ...review }) => review);
}

function nextStats(rating: number, count: number, previous: number | null, stars: number) {
  if (previous === null) {
    const reviewCount = count + 1;
    const next = count > 0 ? (rating * count + stars) / reviewCount : stars;
    return { rating: Math.round(next * 10) / 10, reviewCount };
  }
  const reviewCount = count > 0 ? count : 1;
  return { rating: Math.round(((rating * reviewCount - previous + stars) / reviewCount) * 10) / 10, reviewCount };
}

/** Our own photos (/photos, /uploads) or images on Cloudinary; nothing else is shown as a product photo. */
export function isPhotoSrc(src: string) {
  if (src.includes("..")) return false;
  return src.startsWith("/photos/") || src.startsWith("/uploads/") || /^https:\/\/res\.cloudinary\.com\/[a-z0-9_-]+\/image\/upload\/[A-Za-z0-9_.\/,-]+$/i.test(src);
}
