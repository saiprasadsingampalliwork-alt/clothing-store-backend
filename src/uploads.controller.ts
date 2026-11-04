import { BadRequestException, Body, Controller, Inject, Post, Req } from "@nestjs/common";
import { randomBytes } from "crypto";
import type { Request } from "express";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { requireCatalogStaff } from "./auth";
import { cloudinaryAccount, uploadToCloudinary } from "./cloudinary";
import { PrismaService } from "./prisma.service";

const MAX_BYTES = 6 * 1024 * 1024;

// Photos live on the API server and are served from /uploads by main.ts.
export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.resolve(__dirname, "../uploads"));

@Controller("uploads")
export class UploadsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Post()
  async create(@Req() req: Request, @Body() body: { data?: string }) {
    await requireCatalogStaff(req, this.prisma);
    const parsed = decodeImage(body.data ?? "");
    const id = `photo-${Date.now()}-${randomBytes(4).toString("hex")}`;
    // On hosts without a lasting disk (Render's free plan), photos must live on Cloudinary.
    if (cloudinaryAccount()) {
      try {
        return { url: await uploadToCloudinary(parsed.bytes, parsed.ext, id) };
      } catch (error) {
        console.error("[uploads] Cloudinary upload failed", error);
        throw new BadRequestException("The photo could not be stored. Try again in a moment.");
      }
    }
    const name = `${id}.${parsed.ext}`;
    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(path.join(UPLOAD_DIR, name), parsed.bytes);
    return { url: `/uploads/${name}` };
  }
}

function decodeImage(data: string) {
  const match = data.match(/^data:image\/(jpeg|jpg|png|webp);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) throw new BadRequestException("Use a JPEG, PNG, or WebP photo.");
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!bytes.length || bytes.length > MAX_BYTES) throw new BadRequestException("Use a photo under 6 MB.");
  const ext = extension(bytes);
  if (!ext) throw new BadRequestException("Use a JPEG, PNG, or WebP photo.");
  return { bytes, ext };
}

function extension(bytes: Buffer) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}
