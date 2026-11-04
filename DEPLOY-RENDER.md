# Deploying the API on Render (free)

Everything here is on free plans: **Render** runs the API, **Prisma Postgres** (already in use) holds the data,
**Cloudinary** holds the photos, and a free **uptime pinger** keeps the API awake.

Do the steps in order. Each one names the value to copy into the next.

## 1. Database: get Prisma Postgres's direct connection string

The API on Render connects over standard Postgres, not Prisma Accelerate.

1. Open the [Prisma console](https://console.prisma.io), then your project, then the database.
2. Click **Connect to your database**, then **Generate new connection string**.
3. Copy the **direct** connection string. It looks like
   `postgres://…@db.prisma.io:5432/…`. If it does not already end in `?sslmode=require`, add that.

This is `DATABASE_URL`. Keep it private.

> The free plan counts every query. A small shop fits well within it; if you ever approach the limit, move to
> Neon's free plan with a standard `pg_dump` / `pg_restore`, and change only `DATABASE_URL`.

## 2. Photos: create a free Cloudinary account

1. Sign up at [cloudinary.com](https://cloudinary.com) (free plan, no card).
2. On the dashboard, find **API environment variable**. It looks like
   `cloudinary://123456789012345:abcdEFGH…@your-cloud-name`.

This is `CLOUDINARY_URL`. Keep it private. (Or set the three values the dashboard lists separately:
`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. A secret on its own is not enough.)

## 3. API: create the Render service from the blueprint

1. Merge the backend pull request into `main` (the blueprint deploys `main`).
2. In the [Render dashboard](https://dashboard.render.com): **New → Blueprint**, connect GitHub, and choose
   **clothing-store-backend**. Render reads `render.yaml`: one free web service in Singapore.
3. Fill in the values it asks for:

   | Setting | Value |
   |---|---|
   | `DATABASE_URL` | from step 1 |
   | `CLOUDINARY_URL` | from step 2 |
   | `APP_URL` | your storefront, e.g. `https://clothing-store-yem9-delta.vercel.app` |
   | `CORS_ORIGINS` | other storefront addresses, comma-separated, or leave empty |
   | `PAYMENTS_DEMO` | `true` for a demo store with no payment keys; `false` for a real one |
   | `NOMINATIM_CONTACT` | your email or the shop URL |
   | `SMTP_*`, `STUDIO_INBOX_EMAIL` | your mail provider, or leave empty for now |

   `TOKEN_SECRET` is generated for you. `MESSAGES_DEMO` is fixed to `false`: on a public site it would let anyone
   sign in as any customer.

4. Click **Apply**. The first deploy installs, applies the schema to the database (`prisma db push` only adds
   tables and columns; it stops instead of removing data), and starts the API. Defaults are created on that first
   start: audiences, fabrics from your products, styles, and keys for existing orders.
5. When it is live, open `https://<your-service>.onrender.com/v1/health`. It should say `{"ok":true,…}`.

Add WhatsApp and Razorpay settings later from **Environment** in the service, using `.env.example` as the list.

## 4. Move existing photos to Cloudinary (once)

Photos uploaded before now were saved as `/uploads/…` files, which Render's free plan cannot keep. On your own
computer, in this `server` folder, with `DATABASE_URL` and `CLOUDINARY_URL` set to the **production** values:

```bash
npm run photos:to-cloudinary
```

That only previews. If the list looks right:

```bash
npm run photos:to-cloudinary -- --apply
```

It uploads each file it finds (in `uploads/` and the storefront's old `public/uploads/`) and updates the
database. Any photo it cannot find is listed; upload that one again in the admin.

## 5. Change the staff passwords

The seeded staff passwords are visible in the public repository. With the production `DATABASE_URL` set:

```bash
npm run staff:password -- owner@earthen.in
npm run staff:password -- catalog@earthen.in
npm run staff:password -- orders@earthen.in
```

Each asks for a new password (at least 12 characters) without showing it.

## 6. Keep it awake: a free uptime pinger

Free services sleep after 15 minutes without requests and take about a minute to wake.

1. Create a free monitor at [cron-job.org](https://cron-job.org) or [UptimeRobot](https://uptimerobot.com).
2. URL: `https://<your-service>.onrender.com/v1/health?db=1`, every **10 minutes**.

The free database also sleeps when idle, and the first request to wake it can take several seconds. `?db=1` runs
one tiny query per ping to keep it awake: about 4,300 database operations a month, well inside the free allowance.
Use plain `/v1/health` instead if you would rather save those operations and accept a slow first request after a
quiet spell. Render's free plan includes 750 hours a month, enough for this one service to run all month.

## 7. Point the storefront at Render

1. In **Vercel → clothing-store → Settings → Environment Variables**, set `NEXT_PUBLIC_API_URL` to
   `https://<your-service>.onrender.com/v1` (Production and Preview).
2. Merge the storefront pull request, or redeploy. The API address is fixed at build time, so a redeploy is needed
   after changing it.

## 8. Check the shop

- The home page and shop list products.
- At checkout, typing `560038` fills in Bengaluru Urban, Karnataka.
- "Use my current location" fills in an address (the browser asks permission first).
- In the admin, upload a product photo: it should appear, with an address starting `https://res.cloudinary.com/`.

## Retiring the old Vercel backend

Once the shop works against Render, remove the **clothing-store-backend** project in Vercel (Settings → Delete)
so two copies of the API never run at once.
