# Host the ada backend: Google Cloud + Supabase (Postgres) + GitHub sign-in

The backend is now **stateless** — it stores accounts in Supabase (hosted Postgres), not a local file — so it
runs on any Google host with no persistent disk. Login is "Sign in with GitHub".

Three things you provision (accounts I can't create for you), then I wire + test the app side.

---

## 1. Supabase project (the accounts database) — free

1. Go to https://supabase.com → **New project**. Pick a region near you; set a strong DB password.
2. Once created: **Project Settings → Database → Connection string → "URI"** (use the **Session** pooler,
   port `5432` — NOT the transaction pooler `6543`; Better Auth's migrations need session mode).
3. Copy that URI — it looks like:
   `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
   This is your **`DATABASE_URL`**.

## 2. GitHub OAuth app (the login) — free

1. https://github.com/settings/developers → **New OAuth App**.
2. **Homepage URL:** your backend URL (fill after step 3 — start with `http://localhost:8787`).
3. **Authorization callback URL:** `<backend-url>/api/auth/callback/github`
   (e.g. `http://localhost:8787/api/auth/callback/github` for local testing).
4. Create → copy the **Client ID**, then **Generate a new client secret** → copy it.
   These are **`GITHUB_CLIENT_ID`** and **`GITHUB_CLIENT_SECRET`**.

## 3. Deploy on Google Cloud Run (stateless → this now works)

```bash
# one-time: install gcloud (https://cloud.google.com/sdk/docs/install), then
gcloud auth login                       # YOUR browser login
gcloud config set project <your-project>

# build the container from this repo's Dockerfile and deploy
gcloud run deploy ada-server \
  --source . \
  --region <region> --allow-unauthenticated \
  --set-env-vars "BETTER_AUTH_ENABLED=1,DATABASE_URL=<your-supabase-uri>,BETTER_AUTH_SECRET=<random-32-bytes>,OPENROUTER_API_KEY=<your-key>,GITHUB_CLIENT_ID=<id>,GITHUB_CLIENT_SECRET=<secret>"
# → prints https://ada-server-xxxx.run.app  ← your public URL
```

Then set `BETTER_AUTH_URL` to that printed URL and redeploy, and update the GitHub OAuth app's
Homepage + callback URLs to `https://ada-server-xxxx.run.app` (+ `/api/auth/callback/github`).

Generate the secret: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

> **Why Cloud Run works now:** with `DATABASE_URL` set, the backend keeps zero state on disk — accounts
> live in Supabase. So Cloud Run's ephemeral, scale-to-zero instances are fine. (Free tier covers light use.)

## 4. Migrate the accounts schema (once, against Supabase)

Better Auth's tables must be created in Supabase before first sign-in:

```bash
DATABASE_URL=<your-supabase-uri> BETTER_AUTH_ENABLED=1 BETTER_AUTH_SECRET=<same-secret> \
  npx --yes @better-auth/cli@latest migrate --config src/server/auth.ts -y
```

Run it from this repo (it reads `src/server/auth.ts`, sees `DATABASE_URL`, creates the tables in Postgres).

---

## What I do next (app side)

Once you've done 1–2, give me the **backend URL** and confirm the **GitHub OAuth app exists** (I don't need
the secret — that stays on the host). Then I'll:
- add a "Sign in with GitHub" button to the backend's `/device` page (social login),
- build device-flow sign-in in the Ada app (opens your browser → GitHub → approves → app gets a token),
- set the app's default backend URL to your deployed one, and cut a release.

To test locally first (recommended before paying for anything): create the GitHub OAuth app with the
`localhost:8787` callback, set the four env vars in a local `.env`, run the migration against Supabase,
`node bin/ada-server.mjs`, and I'll verify the whole GitHub sign-in end-to-end before you deploy.
