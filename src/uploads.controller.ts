import { BadRequestException, Body, Controller, Post, Req, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "crypto";
import type { Request } from "express";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { actorFrom } from "./auth";

const MAX_BYTES = 6 * 1024 * 1024;

@Controller("uploads")
export class UploadsController {
  @Post()
  async create(@Req() req: Request, @Body() body: { data?: string }) {
    const actor = actorFrom(req);
    if (!actor || actor.kind !== "staff") throw new UnauthorizedException("Staff sign-in is required.");
    const parsed = decodeImage(body.data ?? "");
    const name = `photo-${Date.now()}-${randomBytes(4).toString("hex")}.${parsed.ext}`;
    const dir = path.resolve(__dirname, "../../public/uploads");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), parsed.bytes);
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
