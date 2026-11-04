/**
 * One-time move of photos saved as /uploads/... files to Cloudinary, updating every reference in the database:
 * product photos, category pictures, and the homepage pictures in store settings.
 *
 *   npm run photos:to-cloudinary                 # preview: lists what would move, changes nothing
 *   npm run photos:to-cloudinary -- --apply      # uploads and updates the database
 *   npm run photos:to-cloudinary -- --apply ../some/other/uploads   # extra folders to look for files in
 *
 * Needs DATABASE_URL (the database to update) and CLOUDINARY_URL. Files are looked for in server/uploads and
 * the storefront's old public/uploads folder.
 */
import "reflect-metadata";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { cloudinaryAccount, uploadToCloudinary } from "../src/cloudinary";

const apply = process.argv.includes("--apply");
const folders = [
  path.resolve(__dirname, "../uploads"),
  path.resolve(__dirname, "../../public/uploads"),
  ...process.argv.slice(2).filter((arg) => arg !== "--apply").map((arg) => path.resolve(arg)),
];
const prisma = new PrismaClient();

/** Every "/uploads/..." string anywhere inside a JSON value. */
function uploadsIn(value: unknown, found: Set<string>) {
  if (typeof value === "string") {
    if (/^\/uploads\/[A-Za-z0-9._-]+$/.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => uploadsIn(item, found));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => uploadsIn(item, found));
  }
}

function replaced<T>(value: T, map: Map<string, string>): T {
  if (typeof value === "string") return (map.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((item) => replaced(item, map)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaced(item, map)])) as T;
  return value;
}

async function main() {
  // Connecting first also loads server/.env, where CLOUDINARY_URL usually lives.
  await prisma.$connect();
  if (!cloudinaryAccount()) throw new Error("Set CLOUDINARY_URL (cloudinary://<api_key>:<api_secret>@<cloud_name>) first.");
  const [products, categories, settings] = await Promise.all([
    prisma.product.findMany({ select: { slug: true, photos: true } }),
    prisma.category.findMany({ select: { slug: true, image: true } }),
    prisma.setting.findMany(),
  ]);
  const wanted = new Set<string>();
  products.forEach((product) => uploadsIn(product.photos, wanted));
  categories.forEach((category) => uploadsIn(category.image, wanted));
  settings.forEach((setting) => uploadsIn(setting.data, wanted));
  console.log(`${wanted.size} photo${wanted.size === 1 ? "" : "s"} in the database use /uploads/.`);

  const map = new Map<string, string>();
  const missing: string[] = [];
  for (const src of wanted) {
    const name = src.slice("/uploads/".length);
    const file = folders.map((folder) => path.join(folder, name)).find((candidate) => existsSync(candidate));
    if (!file) {
      missing.push(src);
      continue;
    }
    if (!apply) {
      console.log(`  would upload ${src}  (from ${path.relative(process.cwd(), file)})`);
      continue;
    }
    const ext = path.extname(name).slice(1).toLowerCase();
    const url = await uploadToCloudinary(readFileSync(file), ext, path.basename(name, path.extname(name)));
    map.set(src, url);
    console.log(`  ${src} -> ${url}`);
  }

  if (apply && map.size) {
    for (const product of products) {
      const next = replaced(product.photos, map);
      if (JSON.stringify(next) !== JSON.stringify(product.photos)) await prisma.product.update({ where: { slug: product.slug }, data: { photos: next as object } });
    }
    for (const category of categories) {
      if (map.has(category.image)) await prisma.category.update({ where: { slug: category.slug }, data: { image: map.get(category.image)! } });
    }
    for (const setting of settings) {
      const next = replaced(setting.data, map);
      if (JSON.stringify(next) !== JSON.stringify(setting.data)) await prisma.setting.update({ where: { id: setting.id }, data: { data: next as object } });
    }
    console.log(`Moved ${map.size} photo${map.size === 1 ? "" : "s"} and updated the database.`);
  }
  if (missing.length) {
    console.log(`\n${missing.length} photo file${missing.length === 1 ? " was" : "s were"} not found locally; upload ${missing.length === 1 ? "it" : "them"} again in the admin:`);
    missing.forEach((src) => console.log(`  ${src}`));
  }
  if (!apply) console.log("\nPreview only. Run again with --apply to upload and update the database.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
