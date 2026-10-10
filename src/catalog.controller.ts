import { BadRequestException, Body, Controller, Get, Inject, Param, Patch, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { actorFrom } from "./auth";
import { PrismaService } from "./prisma.service";

@Controller("catalog")
export class CatalogController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const products = await this.prisma.product.findMany({ orderBy: { name: "asc" } });
    return products.map(presentProduct);
  }

  @Get(":slug")
  async one(@Param("slug") slug: string) {
    const product = await this.prisma.product.findUnique({ where: { slug } });
    if (!product) throw new BadRequestException("Product not found.");
    return presentProduct(product);
  }

  @Patch(":slug")
  async update(@Req() req: Request, @Param("slug") slug: string, @Body() body: Record<string, unknown>) {
    const actor = actorFrom(req);
    if (!actor || actor.kind !== "staff") throw new UnauthorizedException("Staff sign-in is required.");
    const product = await this.prisma.product.findUnique({ where: { slug } });
    if (!product) throw new BadRequestException("Product not found.");
    const updated = await this.prisma.product.update({
      where: { slug },
      data: {
        price: numberOr(body.price, product.price),
        salePrice: body.salePrice === null || body.salePrice === "" ? null : numberOr(body.salePrice, product.salePrice),
        saleStart: stringOr(body.saleStart, product.saleStart),
        saleEnd: stringOr(body.saleEnd, product.saleEnd),
        status: stringOr(body.status, product.status),
        metaTitle: stringOr(body.metaTitle, product.metaTitle),
        metaDescription: stringOr(body.metaDescription, product.metaDescription),
        stock: (body.stock as object) ?? product.stock ?? undefined,
      },
    });
    return presentProduct(updated);
  }
}

function numberOr(value: unknown, fallback: number | null) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

export function presentProduct(product: {
  slug: string;
  name: string;
  price: number;
  category: string;
  fabric: string;
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
}) {
  return {
    product: {
      slug: product.slug,
      name: product.name,
      price: product.price,
      category: product.category,
      fabric: product.fabric,
      description: product.description,
      details: product.details,
      care: product.care,
      rating: product.rating,
      reviewCount: product.reviewCount,
      isNew: product.isNew,
      reviews: product.reviews,
      colors: product.colors,
      sizes: product.sizes,
      stock: product.stock,
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
