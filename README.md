# Fantasy PSL — Fresh Setup Guide

## STEP 1 — Delete Everything Old

### Delete old Vercel project
1. Go to vercel.com → your project → Settings → scroll to bottom
2. Click **Delete Project** → confirm

### Delete old GitHub repo
1. Go to github.com/Mthasap/fantasy-psl-vercel → Settings → scroll to bottom
2. Click **Delete this repository** → type the repo name → confirm

### Delete old Supabase project
1. Go to supabase.com → your project → Settings → General → scroll to bottom
2. Click **Delete Project** → type the project name → confirm

---

## STEP 2 — Create New Supabase Project

1. Go to **supabase.com** → New Project
2. Name: `fantasy-psl`
3. Database Password: choose a strong password (save it)
4. Region: **South Africa (Cape Town)** — closest to your users
5. Click **Create new project** — wait ~2 minutes for it to spin up

### Run the database setup SQL
1. In your new Supabase project → click **SQL Editor** (left sidebar)
2. Click **New query**
3. Open the file `SETUP_DATABASE.sql` from this folder
4. Select all the text → paste it into the SQL editor
5. Click **Run** (green button)
6. You should see a table at the bottom showing rows in each table:
   - clubs: 16 rows
   - players: 128 rows
   - gameweeks: 30 rows
   - fixtures: ~35 rows

### Get your Supabase keys
1. In your Supabase project → Settings → API
2. Copy **Project URL** — looks like: `https://xxxxxxxxxxxx.supabase.co`
3. Copy **anon public** key — the long string under "Project API Keys"
4. Copy **service_role** key — click "Reveal" first (keep this SECRET)

### Update index.html with your new keys
Open `index.html`, find these two lines near the top of the script:

```
const SUPABASE_URL  = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_KEY  = 'YOUR_ANON_KEY';
```

Replace with your new values and save.

---

## STEP 3 — Create New GitHub Repo

1. Go to **github.com** → click **+** → New repository
2. Name: `fantasy-psl`
3. Set to **Private** (your API keys are in the code)
4. Do NOT add README/gitignore (we'll push our own files)
5. Click **Create repository**

### Push all files to GitHub
Open **Command Prompt** and run these commands one by one:

```
cd C:\psl_fantasy
git init
git add .
git commit -m "Initial commit - Fantasy PSL fresh start"
git branch -M main
git remote add origin https://github.com/Mthasap/fantasy-psl.git
git push -u origin main
```

---

## STEP 4 — Create New Vercel Project

1. Go to **vercel.com** → Add New → Project
2. Click **Import Git Repository**
3. Connect to GitHub if asked → select your new `fantasy-psl` repo
4. **IMPORTANT — Framework Preset**: set to **Other** (NOT Next.js)
5. Leave all other settings as default
6. Click **Deploy**

### Add Environment Variables in Vercel
After deploying, go to: Project → Settings → Environment Variables

Add these 4 variables:

| Name | Value |
|------|-------|
| `API_FOOTBALL_KEY` | `efd40a28aa4d2ed1758174bd319553d1` |
| `SUPABASE_URL` | your new Supabase project URL |
| `SUPABASE_SERVICE_KEY` | your new service_role key |
| `NEWS_API_KEY` | `64074f01d6b94feeb870866bdfbc28a3` |

After adding env vars → go to Deployments → click the 3 dots on the latest deploy → **Redeploy**

---

## STEP 5 — Verify Everything Works

1. Visit your Vercel URL (shown after deploy)
2. Try registering a new account
3. Try picking a squad
4. Check Supabase → Table Editor → profiles to see your new user

---

## FILE STRUCTURE

```
fantasy-psl/
├── index.html          ← Main app (all frontend code)
├── fantasy-psl.css     ← All styles
├── manifest.json       ← PWA config
├── favicon.png         ← App icon
├── logo.png            ← Fantasy PSL logo
├── package.json        ← Node.js dependencies (needed for Vercel)
├── vercel.json         ← Vercel config (headers + cron schedule)
├── SETUP_DATABASE.sql  ← Run once in Supabase SQL Editor
└── api/
    ├── football.js     ← API-Football proxy (live scores, player stats)
    ├── points-cron.js  ← Auto points calculation (runs every 30 mins)
    └── psl-data.js     ← PSL news + standings data
```

---

## POINTS SYSTEM (for reference)

| Event | Points |
|-------|--------|
| Appearance 1-59 min | +1 |
| Appearance 60+ min | +2 |
| GK/DEF Goal | +6 |
| MID Goal | +5 |
| FWD Goal | +4 |
| Assist | +3 |
| Clean sheet (GK/DEF, 60+ min) | +4 |
| Clean sheet (MID) | +1 |
| Every 3 saves (GK) | +1 |
| Penalty saved | +5 |
| Penalty missed | -2 |
| Every 2 goals conceded (GK/DEF) | -1 |
| Yellow card | -1 |
| Red card | -3 |
| Captain | ×2 |
| Vice-captain (if captain DNP) | ×2 |
