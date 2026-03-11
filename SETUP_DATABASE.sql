-- ══════════════════════════════════════════════════════════════════════════
--  FANTASY PSL — COMPLETE DATABASE SETUP
--  ► Run this ONCE in: Supabase Dashboard → SQL Editor → New Query
--  ► Paste this entire file, then click RUN
--  ► Safe to run multiple times (IF NOT EXISTS everywhere)
-- ══════════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════════
-- PART 1: CORE TABLES
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS clubs (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  short_name TEXT NOT NULL,
  logo_url   TEXT,
  city       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS players (
  id            SERIAL PRIMARY KEY,
  club_id       INTEGER REFERENCES clubs(id),
  first_name    TEXT,
  last_name     TEXT,
  display_name  TEXT,
  position      TEXT NOT NULL CHECK (position IN ('GK','DEF','MID','FWD')),
  price         NUMERIC(4,1) DEFAULT 5.0,
  total_points  INTEGER DEFAULT 0,
  form          NUMERIC(4,1) DEFAULT 0,
  goals         INTEGER DEFAULT 0,
  assists       INTEGER DEFAULT 0,
  clean_sheets  INTEGER DEFAULT 0,
  yellow_cards  INTEGER DEFAULT 0,
  red_cards     INTEGER DEFAULT 0,
  minutes       INTEGER DEFAULT 0,
  is_available  BOOLEAN DEFAULT TRUE,
  photo_url     TEXT,
  api_id        INTEGER,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gameweeks (
  id          SERIAL PRIMARY KEY,
  number      INTEGER NOT NULL UNIQUE,
  name        TEXT,
  is_current  BOOLEAN DEFAULT FALSE,
  is_finished BOOLEAN DEFAULT FALSE,
  deadline_at TIMESTAMPTZ,
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profiles (
  id                UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username          TEXT UNIQUE NOT NULL,
  team_name         TEXT NOT NULL,
  total_points      INTEGER DEFAULT 0,
  overall_rank      INTEGER,
  gw_points         INTEGER DEFAULT 0,
  last_gw_scored    INTEGER,
  squad_data        TEXT,
  squad_count       INTEGER DEFAULT 0,
  squad_registered  BOOLEAN DEFAULT FALSE,
  free_transfers    INTEGER DEFAULT 1,
  transfers_this_gw INTEGER DEFAULT 0,
  deleted_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS squads (
  id               SERIAL PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_id        INTEGER NOT NULL REFERENCES players(id),
  gameweek_id      INTEGER NOT NULL REFERENCES gameweeks(id),
  is_on_bench      BOOLEAN DEFAULT FALSE,
  is_captain       BOOLEAN DEFAULT FALSE,
  is_vice_captain  BOOLEAN DEFAULT FALSE,
  points_scored    INTEGER DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, player_id, gameweek_id)
);

CREATE TABLE IF NOT EXISTS leagues (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  created_by  UUID REFERENCES auth.users(id),
  is_public   BOOLEAN DEFAULT FALSE,
  logo_url    TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS league_members (
  id         SERIAL PRIMARY KEY,
  league_id  INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(league_id, user_id)
);

CREATE TABLE IF NOT EXISTS fixtures (
  id          BIGSERIAL PRIMARY KEY,
  gameweek    INTEGER NOT NULL,
  home_team   TEXT NOT NULL,
  away_team   TEXT NOT NULL,
  home_score  INTEGER,
  away_score  INTEGER,
  status      TEXT DEFAULT 'NS',
  kickoff_at  TIMESTAMPTZ,
  venue       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS fixtures_match_unique
  ON fixtures (gameweek, home_team, away_team);

CREATE TABLE IF NOT EXISTS gw_scores (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gameweek        INTEGER NOT NULL,
  points          INTEGER NOT NULL DEFAULT 0,
  breakdown       JSONB DEFAULT '{}',
  player_scores   JSONB DEFAULT '[]',
  calculated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, gameweek)
);

CREATE INDEX IF NOT EXISTS gw_scores_gameweek_idx ON gw_scores(gameweek);
CREATE INDEX IF NOT EXISTS gw_scores_user_idx     ON gw_scores(user_id);

CREATE TABLE IF NOT EXISTS processed_fixtures (
  fixture_id      INTEGER PRIMARY KEY,
  gameweek        INTEGER NOT NULL,
  home_team       TEXT NOT NULL,
  away_team       TEXT NOT NULL,
  home_score      INTEGER,
  away_score      INTEGER,
  match_date      TIMESTAMPTZ,
  processed_at    TIMESTAMPTZ DEFAULT NOW(),
  users_scored    INTEGER DEFAULT 0,
  api_calls_used  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS player_gw_stats (
  id                SERIAL PRIMARY KEY,
  player_id         INTEGER REFERENCES players(id) ON DELETE CASCADE,
  api_player_id     INTEGER,
  player_name       TEXT NOT NULL,
  team              TEXT NOT NULL,
  fixture_id        INTEGER NOT NULL,
  gameweek          INTEGER NOT NULL,
  minutes           INTEGER DEFAULT 0,
  goals             INTEGER DEFAULT 0,
  assists           INTEGER DEFAULT 0,
  yellow_cards      INTEGER DEFAULT 0,
  red_cards         INTEGER DEFAULT 0,
  saves             INTEGER DEFAULT 0,
  goals_conceded    INTEGER DEFAULT 0,
  penalties_saved   INTEGER DEFAULT 0,
  penalties_missed  INTEGER DEFAULT 0,
  fantasy_points    INTEGER DEFAULT 0,
  points_breakdown  JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(api_player_id, fixture_id)
);

CREATE INDEX IF NOT EXISTS player_gw_stats_player_idx   ON player_gw_stats(player_id);
CREATE INDEX IF NOT EXISTS player_gw_stats_fixture_idx  ON player_gw_stats(fixture_id);
CREATE INDEX IF NOT EXISTS player_gw_stats_gameweek_idx ON player_gw_stats(gameweek);

CREATE TABLE IF NOT EXISTS potm_votes (
  id         SERIAL PRIMARY KEY,
  match_key  TEXT NOT NULL,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(match_key, user_id)
);

CREATE TABLE IF NOT EXISTS official_potm (
  id         SERIAL PRIMARY KEY,
  match_key  TEXT NOT NULL UNIQUE,
  player_id  INTEGER NOT NULL,
  set_by     UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ══════════════════════════════════════════════════════════════════════════
-- PART 2: AUTO-CREATE PROFILE ON REGISTRATION
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, username, team_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email,'@',1)),
    COALESCE(NEW.raw_user_meta_data->>'team_name', 'My Fantasy Team')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ══════════════════════════════════════════════════════════════════════════
-- PART 3: ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE players          ENABLE ROW LEVEL SECURITY;
ALTER TABLE clubs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE gameweeks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixtures         ENABLE ROW LEVEL SECURITY;
ALTER TABLE squads           ENABLE ROW LEVEL SECURITY;
ALTER TABLE leagues          ENABLE ROW LEVEL SECURITY;
ALTER TABLE league_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE gw_scores        ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_fixtures ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_gw_stats  ENABLE ROW LEVEL SECURITY;
ALTER TABLE potm_votes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE official_potm    ENABLE ROW LEVEL SECURITY;

-- Drop old policies cleanly
DROP POLICY IF EXISTS "profiles_select"   ON profiles;
DROP POLICY IF EXISTS "profiles_update"   ON profiles;
DROP POLICY IF EXISTS "profiles_insert"   ON profiles;
DROP POLICY IF EXISTS "Public profiles readable"   ON profiles;
DROP POLICY IF EXISTS "Users update own profile"   ON profiles;

-- Profiles
CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (true);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_insert" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Read-only public tables
DROP POLICY IF EXISTS "players_read"           ON players;
DROP POLICY IF EXISTS "clubs_read"             ON clubs;
DROP POLICY IF EXISTS "gameweeks_read"         ON gameweeks;
DROP POLICY IF EXISTS "fixtures_read"          ON fixtures;
DROP POLICY IF EXISTS "gw_scores_read"         ON gw_scores;
DROP POLICY IF EXISTS "processed_fixtures_read" ON processed_fixtures;
DROP POLICY IF EXISTS "player_gw_stats_read"   ON player_gw_stats;
DROP POLICY IF EXISTS "official_potm_read"     ON official_potm;

CREATE POLICY "players_read"            ON players           FOR SELECT USING (true);
CREATE POLICY "clubs_read"              ON clubs             FOR SELECT USING (true);
CREATE POLICY "gameweeks_read"          ON gameweeks         FOR SELECT USING (true);
CREATE POLICY "fixtures_read"           ON fixtures          FOR SELECT USING (true);
CREATE POLICY "gw_scores_read"          ON gw_scores         FOR SELECT USING (true);
CREATE POLICY "processed_fixtures_read" ON processed_fixtures FOR SELECT USING (true);
CREATE POLICY "player_gw_stats_read"    ON player_gw_stats   FOR SELECT USING (true);
CREATE POLICY "official_potm_read"      ON official_potm     FOR SELECT USING (true);

-- Squads
DROP POLICY IF EXISTS "squads_own" ON squads;
CREATE POLICY "squads_own" ON squads USING (auth.uid() = user_id);

-- Leagues
DROP POLICY IF EXISTS "leagues_read"   ON leagues;
DROP POLICY IF EXISTS "leagues_create" ON leagues;
CREATE POLICY "leagues_read"   ON leagues FOR SELECT USING (true);
CREATE POLICY "leagues_create" ON leagues FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- League members
DROP POLICY IF EXISTS "league_members_read"  ON league_members;
DROP POLICY IF EXISTS "league_members_join"  ON league_members;
DROP POLICY IF EXISTS "league_members_leave" ON league_members;
CREATE POLICY "league_members_read"  ON league_members FOR SELECT USING (true);
CREATE POLICY "league_members_join"  ON league_members FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "league_members_leave" ON league_members FOR DELETE USING (auth.uid() = user_id);

-- POTM votes
DROP POLICY IF EXISTS "potm_votes_read"   ON potm_votes;
DROP POLICY IF EXISTS "potm_votes_insert" ON potm_votes;
CREATE POLICY "potm_votes_read"   ON potm_votes FOR SELECT USING (true);
CREATE POLICY "potm_votes_insert" ON potm_votes FOR INSERT WITH CHECK (auth.uid() = user_id);


-- ══════════════════════════════════════════════════════════════════════════
-- PART 4: SEED DATA — 16 PSL CLUBS
-- ══════════════════════════════════════════════════════════════════════════

INSERT INTO clubs (name, short_name, city) VALUES
  ('Mamelodi Sundowns',  'SUN', 'Pretoria'),
  ('Orlando Pirates',    'PIR', 'Johannesburg'),
  ('Kaizer Chiefs',      'CHI', 'Johannesburg'),
  ('Stellenbosch FC',    'STB', 'Stellenbosch'),
  ('AmaZulu FC',         'AZU', 'Durban'),
  ('Chippa United',      'CPU', 'Gqeberha'),
  ('Golden Arrows',      'ARR', 'Durban'),
  ('Sekhukhune United',  'SEK', 'Burgersfort'),
  ('TS Galaxy',          'GAL', 'Mpumalanga'),
  ('Polokwane City',     'POL', 'Polokwane'),
  ('Marumo Gallants',    'GAL', 'Limpopo'),
  ('Richards Bay',       'RBA', 'Richards Bay'),
  ('Magesi FC',          'MAG', 'Limpopo'),
  ('Durban City',        'DUR', 'Durban'),
  ('Orbit College FC',   'ORB', 'Rustenburg'),
  ('Siwelele',           'SIW', 'Bloemfontein')
ON CONFLICT (name) DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════════
-- PART 5: SEED DATA — PLAYERS
-- ══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  sun_id INTEGER; pir_id INTEGER; chi_id INTEGER; stb_id INTEGER;
  azu_id INTEGER; cpu_id INTEGER; arr_id INTEGER; sek_id INTEGER;
  gal_id INTEGER; pol_id INTEGER; gal2_id INTEGER; rba_id INTEGER;
  mag_id INTEGER; dur_id INTEGER; orb_id INTEGER; siw_id INTEGER;
BEGIN
  SELECT id INTO sun_id  FROM clubs WHERE name='Mamelodi Sundowns';
  SELECT id INTO pir_id  FROM clubs WHERE name='Orlando Pirates';
  SELECT id INTO chi_id  FROM clubs WHERE name='Kaizer Chiefs';
  SELECT id INTO stb_id  FROM clubs WHERE name='Stellenbosch FC';
  SELECT id INTO azu_id  FROM clubs WHERE name='AmaZulu FC';
  SELECT id INTO cpu_id  FROM clubs WHERE name='Chippa United';
  SELECT id INTO arr_id  FROM clubs WHERE name='Golden Arrows';
  SELECT id INTO sek_id  FROM clubs WHERE name='Sekhukhune United';
  SELECT id INTO gal_id  FROM clubs WHERE name='TS Galaxy';
  SELECT id INTO pol_id  FROM clubs WHERE name='Polokwane City';
  SELECT id INTO gal2_id FROM clubs WHERE name='Marumo Gallants';
  SELECT id INTO rba_id  FROM clubs WHERE name='Richards Bay';
  SELECT id INTO mag_id  FROM clubs WHERE name='Magesi FC';
  SELECT id INTO dur_id  FROM clubs WHERE name='Durban City';
  SELECT id INTO orb_id  FROM clubs WHERE name='Orbit College FC';
  SELECT id INTO siw_id  FROM clubs WHERE name='Siwelele';

  -- MAMELODI SUNDOWNS
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (sun_id,'Denis Onyango',       'GK', 8.0, 62, 0,  0, 8),
    (sun_id,'Aubrey Mkhulise',     'MID',7.5, 71, 4,  6, 0),
    (sun_id,'Grant Lakay',         'MID',7.0, 65, 5,  4, 0),
    (sun_id,'Peter Shalulile',     'FWD',11.0,98,14,  5, 0),
    (sun_id,'Steve Ondama',        'FWD',7.5, 68, 8,  3, 0),
    (sun_id,'Phakamani Modiba',    'DEF',6.0, 54, 1,  3, 5),
    (sun_id,'Hlompho Jali',        'MID',6.5, 58, 3,  5, 0),
    (sun_id,'Sifiso Lunga',        'DEF',6.5, 60, 2,  4, 5)
  ON CONFLICT DO NOTHING;

  -- ORLANDO PIRATES
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (pir_id,'Richard Ofori',       'GK', 7.5, 58, 0,  0, 7),
    (pir_id,'Deon Hotto',          'MID',7.5, 72, 6,  7, 0),
    (pir_id,'Evidence Mabasa',     'FWD',10.0,91,13,  4, 0),
    (pir_id,'Monnapule Maswanganyi','MID',8.0,75, 5,  8, 0),
    (pir_id,'Tshegofatso Ndlondlo','MID',7.5, 70, 4,  6, 0),
    (pir_id,'Thabiso Sesane',      'DEF',5.5, 48, 1,  2, 4),
    (pir_id,'Olisa Mbalula',       'DEF',5.5, 46, 0,  1, 4),
    (pir_id,'Relebohile Mofokeng', 'FWD',8.5, 78, 9,  5, 0)
  ON CONFLICT DO NOTHING;

  -- KAIZER CHIEFS
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (chi_id,'Itumeleng Bvuma',     'GK', 6.5, 50, 0,  0, 5),
    (chi_id,'Mduduzi Shabalala',   'MID',7.0, 64, 5,  4, 0),
    (chi_id,'Pule Nange',          'MID',6.5, 59, 3,  5, 0),
    (chi_id,'Christian Bimenyimana','FWD',9.0,80,11,  3, 0),
    (chi_id,'Rushwin Dortley',     'DEF',5.5, 47, 1,  2, 4),
    (chi_id,'Samkelo Blom',        'MID',6.0, 55, 2,  4, 0),
    (chi_id,'Yusuf Maart',         'MID',7.0, 66, 4,  6, 0),
    (chi_id,'Ranga Lepasa',        'FWD',8.0, 72, 8,  2, 0)
  ON CONFLICT DO NOTHING;

  -- STELLENBOSCH FC
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (stb_id,'Lee Langeveldt',      'GK', 5.5, 44, 0,  0, 5),
    (stb_id,'Junior Fredericks',   'MID',6.5, 60, 4,  5, 0),
    (stb_id,'Sibusiso Ditlhokwe',  'DEF',6.0, 52, 2,  2, 5),
    (stb_id,'Devin Van der Berg',  'FWD',7.5, 68, 7,  3, 0),
    (stb_id,'Lehlohonolo Mahlatsi','MID',6.0, 54, 3,  4, 0),
    (stb_id,'Siphesihle Ntutu',    'MID',5.5, 48, 2,  3, 0),
    (stb_id,'Ashley Zuma',         'DEF',5.0, 42, 0,  2, 4),
    (stb_id,'Iqraam Petersen',     'FWD',8.5, 76, 9,  4, 0)
  ON CONFLICT DO NOTHING;

  -- AMAZULU FC
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (azu_id,'Veli Mothwa',         'GK', 6.0, 48, 0,  0, 5),
    (azu_id,'Gabadinho Mhango',    'FWD',8.0, 70, 9,  3, 0),
    (azu_id,'Bongani Zungu',       'MID',7.5, 66, 3,  5, 0),
    (azu_id,'Sifiso Maphalala',    'DEF',5.5, 46, 0,  2, 4),
    (azu_id,'Siphelele Zulu',      'FWD',7.0, 62, 7,  2, 0),
    (azu_id,'Bongi Ntuli',         'FWD',6.5, 58, 5,  2, 0),
    (azu_id,'Siyethemba Gumede',   'MID',6.0, 53, 2,  4, 0),
    (azu_id,'Tapelo Dlamini',      'DEF',5.0, 40, 0,  1, 3)
  ON CONFLICT DO NOTHING;

  -- CHIPPA UNITED
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (cpu_id,'Siyabonga Mlungwana', 'GK', 5.0, 38, 0,  0, 3),
    (cpu_id,'Lyle Hendricks',      'MID',6.0, 52, 3,  4, 0),
    (cpu_id,'Cole Alexander',      'FWD',6.5, 57, 6,  2, 0),
    (cpu_id,'Goodman Mosele',      'MID',5.5, 46, 2,  3, 0),
    (cpu_id,'Bienvenu Eva Nga',    'FWD',7.0, 62, 7,  2, 0),
    (cpu_id,'Wandile Shabalala',   'DEF',5.0, 41, 1,  1, 3),
    (cpu_id,'Thembela Nkosi',      'MID',5.5, 47, 2,  3, 0),
    (cpu_id,'Sinoxolo Kwayiba',    'DEF',4.5, 36, 0,  1, 3)
  ON CONFLICT DO NOTHING;

  -- GOLDEN ARROWS
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (arr_id,'Nkosingiphile Mabokela','GK',5.0,39,0, 0, 3),
    (arr_id,'Phumlani Nzuza',      'MID',5.5, 48, 2,  3, 0),
    (arr_id,'Nduduzo Sibiya',      'FWD',6.5, 58, 6,  2, 0),
    (arr_id,'Sibonelo Mzimela',    'DEF',5.0, 41, 1,  1, 3),
    (arr_id,'Tokelo Rantie',       'FWD',7.0, 62, 7,  3, 0),
    (arr_id,'Nhlanhla Cele',       'MID',5.5, 47, 2,  2, 0),
    (arr_id,'Sifiso Gumbi',        'DEF',5.0, 40, 0,  2, 3),
    (arr_id,'Mthokozisi Dlamini',  'MID',5.5, 46, 3,  3, 0)
  ON CONFLICT DO NOTHING;

  -- SEKHUKHUNE UNITED
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (sek_id,'Brandon Swannepoel',  'GK', 5.5, 43, 0,  0, 4),
    (sek_id,'Elias Mthembu',       'MID',6.0, 53, 3,  4, 0),
    (sek_id,'Nkosinathi Lukhubeni','DEF',5.5, 49, 1,  2, 4),
    (sek_id,'Lebo Mothiba',        'FWD',8.0, 70, 9,  3, 0),
    (sek_id,'Tshegofatso Mabasa',  'FWD',7.5, 66, 8,  2, 0),
    (sek_id,'Siphiwe Zwane',       'MID',6.0, 52, 2,  3, 0),
    (sek_id,'George Maluleka',     'MID',5.5, 47, 2,  2, 0),
    (sek_id,'Given Msimango',      'DEF',5.0, 40, 0,  1, 3)
  ON CONFLICT DO NOTHING;

  -- TS GALAXY
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (gal_id,'Siyanda Nkosi',       'GK', 5.0, 38, 0,  0, 3),
    (gal_id,'Thabiso Motupa',      'FWD',7.0, 62, 7,  3, 0),
    (gal_id,'Sibusiso Modisane',   'MID',6.0, 52, 3,  3, 0),
    (gal_id,'Nkosinathi Mthethwa', 'DEF',5.0, 41, 1,  1, 3),
    (gal_id,'Lindokuhle Mbatha',   'MID',5.5, 47, 2,  3, 0),
    (gal_id,'Hlompho Kekana',      'MID',6.5, 57, 3,  5, 0),
    (gal_id,'Luvuyo Memela',       'FWD',6.0, 52, 5,  2, 0),
    (gal_id,'Sifiso Ngobeni',      'DEF',5.0, 40, 0,  1, 3)
  ON CONFLICT DO NOTHING;

  -- POLOKWANE CITY
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (pol_id,'Reyaad Pieterse',     'GK', 5.0, 37, 0,  0, 3),
    (pol_id,'Aphiwe Zulu',         'MID',5.5, 46, 2,  3, 0),
    (pol_id,'Shaquell Barnabas',   'FWD',6.0, 52, 5,  2, 0),
    (pol_id,'Papi Zothwane',       'MID',5.5, 47, 2,  2, 0),
    (pol_id,'Keenan Philander',    'DEF',5.0, 40, 0,  1, 3),
    (pol_id,'Bonginkosi Makume',   'MID',5.5, 46, 2,  3, 0),
    (pol_id,'Ndumiso Mabena',      'FWD',6.5, 56, 6,  2, 0),
    (pol_id,'Katlego Otladisa',    'DEF',5.0, 39, 0,  2, 3)
  ON CONFLICT DO NOTHING;

  -- MARUMO GALLANTS
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (gal2_id,'Thakgalo Leshabela', 'GK', 5.0, 37, 0,  0, 3),
    (gal2_id,'Reneilwe Letsholonyane','MID',5.5,46,2, 2, 0),
    (gal2_id,'Fawaaz Basadien',    'DEF',5.5, 47, 1,  2, 3),
    (gal2_id,'Kamohelo Mahlasela', 'FWD',6.0, 51, 5,  1, 0),
    (gal2_id,'Lungelo Nguse',      'MID',5.0, 42, 2,  2, 0),
    (gal2_id,'Keagan Buchanan',    'MID',5.5, 46, 2,  3, 0),
    (gal2_id,'Bathusi Aubaas',     'DEF',5.0, 40, 0,  1, 3),
    (gal2_id,'Siphamandla Nzama',  'FWD',6.0, 52, 5,  2, 0)
  ON CONFLICT DO NOTHING;

  -- RICHARDS BAY
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (rba_id,'Sanele Mthethwa',     'GK', 4.5, 34, 0,  0, 3),
    (rba_id,'Nhlanhla Mkhize',     'MID',5.0, 42, 2,  2, 0),
    (rba_id,'Riyaaz Habieb',       'FWD',5.5, 48, 4,  2, 0),
    (rba_id,'Riyaad Norodien',     'DEF',4.5, 36, 0,  1, 3),
    (rba_id,'Lungelo Khumalo',     'MID',5.0, 42, 2,  2, 0),
    (rba_id,'Mxolisi Macuphu',     'FWD',5.5, 47, 4,  1, 0),
    (rba_id,'Nhlakanipho Vilakazi','MID',5.0, 42, 2,  2, 0),
    (rba_id,'Lindani Zungu',       'DEF',4.5, 36, 0,  1, 3)
  ON CONFLICT DO NOTHING;

  -- MAGESI FC
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (mag_id,'Murunwa Chauke',      'GK', 4.5, 33, 0,  0, 2),
    (mag_id,'Mpho Mulaudzi',       'MID',5.0, 42, 2,  2, 0),
    (mag_id,'Lefa Hlongwane',      'FWD',5.5, 47, 4,  2, 0),
    (mag_id,'Thapelo Masihleho',   'DEF',4.5, 35, 0,  1, 2),
    (mag_id,'Taariq Fielies',      'MID',5.0, 41, 2,  2, 0),
    (mag_id,'Teboho Mokoena',      'MID',6.0, 53, 3,  4, 0),
    (mag_id,'Puso Mhlongo',        'FWD',5.5, 48, 4,  1, 0),
    (mag_id,'Judas Moseamedi',     'DEF',4.5, 35, 0,  1, 2)
  ON CONFLICT DO NOTHING;

  -- DURBAN CITY
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (dur_id,'Ayanda Dlamini',      'GK', 4.5, 33, 0,  0, 2),
    (dur_id,'Sibusiso Vilane',     'MID',5.0, 42, 2,  2, 0),
    (dur_id,'Victor Letsoalo',     'FWD',6.5, 57, 6,  2, 0),
    (dur_id,'Teenage Hadebe',      'DEF',5.5, 47, 1,  2, 2),
    (dur_id,'Themba Zwane',        'MID',5.5, 47, 2,  3, 0),
    (dur_id,'Bonginkosi Ntuli',    'FWD',6.0, 52, 5,  2, 0),
    (dur_id,'Nqobeko Dlamini',     'MID',5.0, 41, 2,  2, 0),
    (dur_id,'Siyanda Dlamini',     'DEF',4.5, 35, 0,  1, 2)
  ON CONFLICT DO NOTHING;

  -- ORBIT COLLEGE FC
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (orb_id,'Sipho Mbatha',        'GK', 4.5, 32, 0,  0, 2),
    (orb_id,'Keenan Fortune',      'MID',5.0, 40, 2,  2, 0),
    (orb_id,'Sello Motsepe',       'FWD',5.5, 46, 4,  1, 0),
    (orb_id,'Thabang Mokoena',     'DEF',4.5, 34, 0,  1, 2),
    (orb_id,'Lungisa Dlamini',     'MID',5.0, 40, 2,  2, 0),
    (orb_id,'Lehlohonolo Seema',   'FWD',5.5, 45, 4,  1, 0),
    (orb_id,'Justice Figuareido',  'DEF',4.5, 34, 0,  1, 2),
    (orb_id,'Tshepo Masilela',     'MID',5.0, 40, 1,  3, 0)
  ON CONFLICT DO NOTHING;

  -- SIWELELE
  INSERT INTO players (club_id,display_name,position,price,total_points,goals,assists,clean_sheets) VALUES
    (siw_id,'Patrick Tignyemb',    'GK', 4.5, 34, 0,  0, 3),
    (siw_id,'Teboho Sefala',       'MID',5.0, 41, 2,  2, 0),
    (siw_id,'Lefa Hlongwane',      'FWD',5.5, 47, 4,  2, 0),
    (siw_id,'Sifiso Ngobeni',      'DEF',4.5, 35, 0,  1, 3),
    (siw_id,'Sibusiso Khumalo',    'MID',5.0, 41, 2,  2, 0),
    (siw_id,'Lehlohonolo Nkosi',   'FWD',5.5, 46, 4,  1, 0),
    (siw_id,'Mpho Kgaswane',       'DEF',4.5, 34, 0,  1, 3),
    (siw_id,'Nhlanhla Mahlangu',   'MID',5.0, 40, 1,  2, 0)
  ON CONFLICT DO NOTHING;

END $$;


-- ══════════════════════════════════════════════════════════════════════════
-- PART 6: GAMEWEEKS (2025/26 Season)
-- ══════════════════════════════════════════════════════════════════════════

INSERT INTO gameweeks (number, name, is_current, is_finished, deadline_at) VALUES
  (1,  'Gameweek 1',  FALSE, TRUE,  '2025-08-08 18:00:00+02'),
  (2,  'Gameweek 2',  FALSE, TRUE,  '2025-08-15 18:00:00+02'),
  (3,  'Gameweek 3',  FALSE, TRUE,  '2025-08-22 18:00:00+02'),
  (4,  'Gameweek 4',  FALSE, TRUE,  '2025-08-29 18:00:00+02'),
  (5,  'Gameweek 5',  FALSE, TRUE,  '2025-09-12 18:00:00+02'),
  (6,  'Gameweek 6',  FALSE, TRUE,  '2025-09-19 18:00:00+02'),
  (7,  'Gameweek 7',  FALSE, TRUE,  '2025-09-26 18:00:00+02'),
  (8,  'Gameweek 8',  FALSE, TRUE,  '2025-10-03 18:00:00+02'),
  (9,  'Gameweek 9',  FALSE, TRUE,  '2025-10-17 18:00:00+02'),
  (10, 'Gameweek 10', FALSE, TRUE,  '2025-10-24 18:00:00+02'),
  (11, 'Gameweek 11', FALSE, TRUE,  '2025-10-31 18:00:00+02'),
  (12, 'Gameweek 12', FALSE, TRUE,  '2025-11-07 18:00:00+02'),
  (13, 'Gameweek 13', FALSE, TRUE,  '2025-11-21 18:00:00+02'),
  (14, 'Gameweek 14', FALSE, TRUE,  '2025-11-28 18:00:00+02'),
  (15, 'Gameweek 15', FALSE, TRUE,  '2025-12-05 18:00:00+02'),
  (16, 'Gameweek 16', FALSE, TRUE,  '2025-12-12 18:00:00+02'),
  (17, 'Gameweek 17', FALSE, TRUE,  '2026-01-09 18:00:00+02'),
  (18, 'Gameweek 18', FALSE, TRUE,  '2026-01-16 18:00:00+02'),
  (19, 'Gameweek 19', FALSE, TRUE,  '2026-01-23 18:00:00+02'),
  (20, 'Gameweek 20', FALSE, TRUE,  '2026-01-30 18:00:00+02'),
  (21, 'Gameweek 21', FALSE, TRUE,  '2026-02-27 16:00:00+02'),
  (22, 'Gameweek 22', FALSE, TRUE,  '2026-03-03 16:00:00+02'),
  (23, 'Gameweek 23', TRUE,  FALSE, '2026-03-10 16:00:00+02'),
  (24, 'Gameweek 24', FALSE, FALSE, '2026-03-18 16:00:00+02'),
  (25, 'Gameweek 25', FALSE, FALSE, '2026-04-06 16:00:00+02'),
  (26, 'Gameweek 26', FALSE, FALSE, '2026-04-10 16:00:00+02'),
  (27, 'Gameweek 27', FALSE, FALSE, '2026-04-17 16:00:00+02'),
  (28, 'Gameweek 28', FALSE, FALSE, '2026-04-24 16:00:00+02'),
  (29, 'Gameweek 29', FALSE, FALSE, '2026-05-01 16:00:00+02'),
  (30, 'Gameweek 30', FALSE, FALSE, '2026-05-08 16:00:00+02')
ON CONFLICT (number) DO UPDATE SET
  is_current  = EXCLUDED.is_current,
  is_finished = EXCLUDED.is_finished,
  deadline_at = EXCLUDED.deadline_at;


-- ══════════════════════════════════════════════════════════════════════════
-- PART 7: FIXTURES (GW21, GW22, GW23, GW24, GW25)
-- ══════════════════════════════════════════════════════════════════════════

-- GW21 RESULTS
INSERT INTO fixtures (gameweek,home_team,away_team,home_score,away_score,status,kickoff_at) VALUES
  (21,'Stellenbosch FC',  'AmaZulu FC',        1,0,'FT','2026-02-27 17:30:00+02'),
  (21,'Magesi FC',        'Polokwane City',    0,2,'FT','2026-02-27 17:30:00+02'),
  (21,'Orbit College FC', 'Richards Bay',      0,0,'FT','2026-02-28 17:30:00+02'),
  (21,'Siwelele',         'TS Galaxy',         1,0,'FT','2026-02-28 17:30:00+02'),
  (21,'Golden Arrows',    'Chippa United',     0,0,'FT','2026-02-28 17:30:00+02'),
  (21,'Kaizer Chiefs',    'Orlando Pirates',   0,3,'FT','2026-02-28 17:30:00+02'),
  (21,'Marumo Gallants',  'Durban City',       0,1,'FT','2026-03-01 15:30:00+02'),
  (21,'Mamelodi Sundowns','Sekhukhune United', 3,1,'FT','2026-03-01 17:30:00+02')
ON CONFLICT DO NOTHING;

-- GW22 RESULTS
INSERT INTO fixtures (gameweek,home_team,away_team,home_score,away_score,status,kickoff_at) VALUES
  (22,'TS Galaxy',        'Orbit College FC',  1,2,'FT','2026-03-03 17:30:00+02'),
  (22,'Siwelele',         'Stellenbosch FC',   0,0,'FT','2026-03-03 17:30:00+02'),
  (22,'Richards Bay',     'Kaizer Chiefs',     1,0,'FT','2026-03-03 17:30:00+02'),
  (22,'Polokwane City',   'Orlando Pirates',   1,2,'FT','2026-03-04 19:30:00+02'),
  (22,'Mamelodi Sundowns','Golden Arrows',     2,1,'FT','2026-03-04 19:30:00+02'),
  (22,'Durban City',      'Sekhukhune United', 1,1,'FT','2026-03-04 17:30:00+02'),
  (22,'Chippa United',    'Marumo Gallants',   1,3,'FT','2026-03-04 15:00:00+02'),
  (22,'AmaZulu FC',       'Magesi FC',         0,0,'FT','2026-03-04 15:00:00+02')
ON CONFLICT DO NOTHING;

-- GW23 UPCOMING
INSERT INTO fixtures (gameweek,home_team,away_team,status,kickoff_at) VALUES
  (23,'Orbit College FC', 'Mamelodi Sundowns','NS','2026-03-10 17:30:00+02'),
  (23,'Orlando Pirates',  'Richards Bay',     'NS','2026-03-11 17:30:00+02'),
  (23,'Stellenbosch FC',  'TS Galaxy',        'NS','2026-03-13 17:30:00+02'),
  (23,'Magesi FC',        'Chippa United',    'NS','2026-03-14 13:30:00+02'),
  (23,'Orlando Pirates',  'Siwelele',         'NS','2026-03-14 13:30:00+02'),
  (23,'Marumo Gallants',  'Golden Arrows',    'NS','2026-03-14 13:30:00+02'),
  (23,'AmaZulu FC',       'Richards Bay',     'NS','2026-03-14 16:00:00+02'),
  (23,'Sekhukhune United','Polokwane City',   'NS','2026-03-14 16:00:00+02'),
  (23,'Kaizer Chiefs',    'Durban City',      'NS','2026-03-15 13:30:00+02')
ON CONFLICT DO NOTHING;

-- GW24 UPCOMING
INSERT INTO fixtures (gameweek,home_team,away_team,status,kickoff_at) VALUES
  (24,'Golden Arrows',    'Stellenbosch FC',  'NS','2026-03-18 17:30:00+02'),
  (24,'Polokwane City',   'AmaZulu FC',       'NS','2026-03-21 13:30:00+02'),
  (24,'Stellenbosch FC',  'Chippa United',    'NS','2026-03-21 13:30:00+02'),
  (24,'Kaizer Chiefs',    'Magesi FC',        'NS','2026-03-21 16:00:00+02'),
  (24,'Mamelodi Sundowns','Marumo Gallants',  'NS','2026-03-21 18:00:00+02'),
  (24,'Siwelele',         'Orbit College FC', 'NS','2026-03-22 13:30:00+02'),
  (24,'Golden Arrows',    'Sekhukhune United','NS','2026-03-22 13:30:00+02'),
  (24,'TS Galaxy',        'Orlando Pirates',  'NS','2026-03-22 13:30:00+02'),
  (24,'Durban City',      'Richards Bay',     'NS','2026-03-22 15:30:00+02')
ON CONFLICT DO NOTHING;

-- GW25 UPCOMING
INSERT INTO fixtures (gameweek,home_team,away_team,status,kickoff_at) VALUES
  (25,'AmaZulu FC',       'Sekhukhune United','NS','2026-04-06 17:30:00+02'),
  (25,'Chippa United',    'Siwelele',         'NS','2026-04-07 17:30:00+02'),
  (25,'Durban City',      'Mamelodi Sundowns','NS','2026-04-07 17:30:00+02'),
  (25,'Magesi FC',        'Marumo Gallants',  'NS','2026-04-07 17:30:00+02'),
  (25,'Orbit College FC', 'Kaizer Chiefs',    'NS','2026-04-07 17:30:00+02'),
  (25,'Orlando Pirates',  'Golden Arrows',    'NS','2026-04-07 17:30:00+02'),
  (25,'Richards Bay',     'Stellenbosch FC',  'NS','2026-04-07 17:30:00+02')
ON CONFLICT DO NOTHING;


-- ══════════════════════════════════════════════════════════════════════════
-- VERIFY — Run this to confirm everything is set up correctly
-- ══════════════════════════════════════════════════════════════════════════
SELECT 'clubs'      AS tbl, COUNT(*) AS rows FROM clubs
UNION ALL SELECT 'players',     COUNT(*) FROM players
UNION ALL SELECT 'gameweeks',   COUNT(*) FROM gameweeks
UNION ALL SELECT 'fixtures',    COUNT(*) FROM fixtures
UNION ALL SELECT 'profiles',    COUNT(*) FROM profiles
UNION ALL SELECT 'gw_scores',   COUNT(*) FROM gw_scores
ORDER BY tbl;
