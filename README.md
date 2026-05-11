# xAI license server

Small Express API: `POST /api/validate` (public), `/api/admin/*` (password).

## Environment

Copy `.env.example` to `.env` on the server:

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Listen port (default `3847`) |
| `ADMIN_PASSWORD` | **Yes** for admin | Same value you enter in the admin UI header field |
| `SUPABASE_URL` | **Yes** | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Server-only key to access the DB |

If `ADMIN_PASSWORD` is unset, admin routes return **503** (validate still works).

## Supabase schema

Create table `licenses` (SQL editor):

```sql
create table if not exists public.licenses (
  id bigserial primary key,
  key text not null unique,
  label text not null default 'unnamed',
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);
```

This server uses the **Service Role key**, so you do not need to expose this table to clients.

## Deploy on VPS (Node + PM2)

```bash
cd /opt/xai-license-server
cp .env.example .env   # edit: ADMIN_PASSWORD, optional PORT
npm ci --omit=dev
npm install -g pm2
pm2 start index.js --name xai-license
pm2 save && pm2 startup
```

Put **HTTPS** in front (Nginx + Let’s Encrypt). Example public base: `https://assesthub.in`  
Mobile app / APK: set that URL as the license API base (or `EXPO_PUBLIC_LICENSE_API_URL` at build time).

## Docker

```bash
docker build -t xai-license .
docker run -d --name xai-license -p 3847:3847 \
  -e ADMIN_PASSWORD=your-secret \
  -v xai-license-data:/app/data \
  xai-license
```

Mount `/app/data` so `licenses.json` survives container restarts.

## Admin UI

From the main repo root: `npm run dev` → open `/admin.html`. Set **License API base** to your public URL and the **Admin password** to match `ADMIN_PASSWORD`.

## GitHub

```bash
cd license-server
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```
