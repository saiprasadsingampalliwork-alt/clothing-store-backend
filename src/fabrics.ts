import { BadRequestException } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";
import { categorySlug } from "./category-slug";

/** "Washed linen, 160 gsm" into the fabric and its weight. Joining them with ", " gives the original back. */
export function splitFabric(value: string) {
  const text = value.trim().replace(/\s+/g, " ");
  const at = text.indexOf(", ");
  return at < 0 ? { fabric: text, detail: "" } : { fabric: text.slice(0, at), detail: text.slice(at + 2) };
}

export function cleanFabricLabel(value: unknown) {
  const label = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (!label) throw new BadRequestException("A fabric needs a name.");
  return label[0].toUpperCase() + label.slice(1);
}

export function cleanDetail(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
}

/**
 * The first time the API starts with no fabrics, builds the list from the products and moves each
 * product's weight into its own field. Display text stays the same.
 */
export async function ensureFabrics(prisma: PrismaClient) {
  if ((await prisma.fabric.count()) > 0) return;
  const products = await prisma.product.findMany({ select: { slug: true, fabric: true, fabricDetail: true } });
  const labels = new Map<string, string>();
  for (const product of products) {
    const { fabric, detail } = product.fabricDetail ? { fabric: product.fabric, detail: product.fabricDetail } : splitFabric(product.fabric || "Cotton");
    const label = cleanFabricLabel(fabric);
    labels.set(label.toLowerCase(), labels.get(label.toLowerCase()) ?? label);
    const canonical = labels.get(label.toLowerCase())!;
    if (canonical !== product.fabric || detail !== product.fabricDetail) {
      await prisma.product.update({ where: { slug: product.slug }, data: { fabric: canonical, fabricDetail: detail } });
    }
  }
  if (!labels.size) labels.set("cotton", "Cotton");
  for (const label of labels.values()) {
    await prisma.fabric.upsert({ where: { label }, create: { slug: await freeSlug(prisma, label), label }, update: {} });
  }
}

/** Finds a fabric by name, ignoring case. With `create`, adds it when missing (CSV import). */
export async function resolveFabric(prisma: PrismaClient, value: unknown, create = false) {
  const label = cleanFabricLabel(value);
  const fabrics = await prisma.fabric.findMany();
  const found = fabrics.find((row) => row.label.toLowerCase() === label.toLowerCase());
  if (found) return found.label;
  if (!create) throw new BadRequestException(`"${label}" is not in the fabrics list. Add it under Fabrics first.`);
  await prisma.fabric.create({ data: { slug: await freeSlug(prisma, label), label } });
  return label;
}

export async function freeSlug(prisma: PrismaClient, label: string) {
  const base = categorySlug(label) || "fabric";
  let slug = base;
  for (let n = 2; await prisma.fabric.findUnique({ where: { slug } }); n += 1) slug = `${base}-${n}`;
  return slug;
}
