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

-- Required: PostgREST checks table GRANTs before RLS. Without this you get
-- "permission denied for table licenses" even with the service_role JWT.
grant usage on schema public to service_role;
grant all on table public.licenses to service_role;
grant usage, select on sequence public.licenses_id_seq to service_role;

-- This table is only touched by your Node server (service_role). Keep RLS off
-- so you do not need policies for dashboard vs API confusion.
alter table public.licenses disable row level security;
```

**Already have the table?** Run only the `grant` / `alter` lines above in the SQL Editor (same order).

If your primary key is **not** `bigserial` (e.g. UUID), skip the `licenses_id_seq` line or adjust the sequence name.

This server uses the **Service Role key** in Node; do **not** grant `anon` access to `licenses` (that would expose keys to the browser).

### Admin shows `db error`

After deploy, open `/admin` again (hard refresh). The API now returns a **`detail`** field with the real Supabase/PostgREST message.

Typical fixes:

| `detail` contains | Fix |
|-------------------|-----|
| `relation "public.licenses" does not exist` | Run the SQL above in Supabase **SQL Editor** |
| `JWT expired` / `Invalid API key` | Regenerate **service_role** key in Project Settings → API; paste into `SUPABASE_SERVICE_ROLE_KEY` with no extra spaces/newlines |
| `permission denied for table licenses` | Run the **`grant … to service_role`** (and sequence + `disable row level security`) lines from the SQL block above — see [Postgres roles / grants](https://supabase.com/docs/guides/database/postgres/roles) |

Check server logs: lines like `[GET /api/admin/licenses] Supabase error:` show the same message.

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
