import { createHash } from "crypto";

/**
 * Product and page photos on Cloudinary, for hosts without a lasting disk (Render's free plan).
 * Set CLOUDINARY_URL to the "API environment variable" from the Cloudinary dashboard:
 *   cloudinary://<api_key>:<api_secret>@<cloud_name>
 * or set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET separately.
 * Without it, photos are saved to the local uploads folder instead.
 */
type Account = { cloud: string; key: string; secret: string };

export function cloudinaryAccount(): Account | null {
  const raw = process.env.CLOUDINARY_URL?.trim();
  const match = raw?.match(/^cloudinary:\/\/([^:]+):([^@]+)@([a-z0-9_-]+)$/i);
  if (match) return { key: match[1], secret: match[2], cloud: match[3] };
  // Or the three values as the Cloudinary dashboard lists them.
  const cloud = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const key = process.env.CLOUDINARY_API_KEY?.trim();
  const secret = process.env.CLOUDINARY_API_SECRET?.trim();
  return cloud && key && secret ? { cloud, key, secret } : null;
}

/** Uploads one image and returns its https URL on Cloudinary's image network. */
export async function uploadToCloudinary(bytes: Buffer, ext: string, publicId: string) {
  const account = cloudinaryAccount();
  if (!account) throw new Error("CLOUDINARY_URL is not set.");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const folder = process.env.CLOUDINARY_FOLDER?.trim() || "earthen";
  // Cloudinary's signed upload: the parameters in alphabetical order, then the API secret, hashed with SHA-1.
  const signed = { folder, public_id: publicId, timestamp };
  const signature = createHash("sha1")
    .update(
      Object.entries(signed)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}=${value}`)
        .join("&") + account.secret,
    )
    .digest("hex");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: `image/${ext === "jpg" ? "jpeg" : ext}` }), `${publicId}.${ext}`);
  form.append("api_key", account.key);
  form.append("timestamp", timestamp);
  form.append("folder", folder);
  form.append("public_id", publicId);
  form.append("signature", signature);
  const response = await fetch(`https://api.cloudinary.com/v1_1/${account.cloud}/image/upload`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  const data = (await response.json().catch(() => ({}))) as { secure_url?: string; error?: { message?: string } };
  if (!response.ok || !data.secure_url) throw new Error(data.error?.message || `Cloudinary answered ${response.status}`);
  return data.secure_url;
}
