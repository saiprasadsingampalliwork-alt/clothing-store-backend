import { BadRequestException } from "@nestjs/common";
import { categorySlug } from "./category-slug";
import type { PrismaClient } from "@prisma/client";

export const DEFAULT_STYLES = ["Casual", "Formal", "Ethnic", "Traditional"];

export function cleanStyleLabel(value: unknown) {
  const label = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!label) throw new BadRequestException("A style needs a name.");
  return label[0].toUpperCase() + label.slice(1);
}

/** The first time the API starts with no styles: adds the defaults and marks existing products Casual. */
export async function ensureStyles(prisma: PrismaClient) {
  if ((await prisma.style.count()) > 0) return;
  await prisma.style.createMany({ data: DEFAULT_STYLES.map((label, sort) => ({ slug: categorySlug(label), label, sort })) });
  await prisma.product.updateMany({ where: { styles: { isEmpty: true } }, data: { styles: ["casual"] } });
}

/**
 * Turns names or slugs into style slugs: an array, or "Ethnic; Festive" from a CSV cell.
 * Unknown names are refused, or added to the list when `create` is set (CSV import).
 */
export async function resolveStyles(prisma: PrismaClient, value: unknown, create = false) {
  const wanted = (Array.isArray(value) ? value : String(value ?? "").split(/[;,]/))
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  if (wanted.length > 12) throw new BadRequestException("Choose at most 12 styles.");
  const styles = await prisma.style.findMany();
  const slugs: string[] = [];
  for (const item of wanted) {
    const lower = item.toLowerCase();
    let found = styles.find((row) => row.slug === lower || row.label.toLowerCase() === lower);
    if (!found) {
      if (!create) throw new BadRequestException(`"${item}" is not a style. Add it under Styles first.`);
      const label = cleanStyleLabel(item);
      const sort = ((await prisma.style.aggregate({ _max: { sort: true } }))._max.sort ?? -1) + 1;
      found = await prisma.style.create({ data: { slug: await freeStyleSlug(prisma, label), label, sort } });
      styles.push(found);
    }
    if (!slugs.includes(found.slug)) slugs.push(found.slug);
  }
  return slugs;
}

export async function freeStyleSlug(prisma: PrismaClient, label: string) {
  const base = categorySlug(label) || "style";
  let slug = base;
  for (let n = 2; await prisma.style.findUnique({ where: { slug } }); n += 1) slug = `${base}-${n}`;
  return slug;
}
