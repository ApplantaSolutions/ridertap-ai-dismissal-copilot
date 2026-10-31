-- RiderTap PRODUCTION schema (Turso / libSQL — same SQLite dialect as the
-- Muse artifact's app.db, so the Drizzle sqlite-core schema ports 1:1).
--
-- Differences from the artifact schema, and why:
--   1. Multi-tenancy: a `schools` registry table + `school_id` on every table.
--      The artifact is single-school (school row id=1); production is ONE
--      deployment serving many schools, each fully isolated by school_id.
--   2. Atomic duplicate guard: a PARTIAL UNIQUE INDEX on active entries.
--      The artifact's addEntry does check-then-insert (safe inside the
--      artifact's serialized runtime). In production this index makes the
--      database itself reject a second ACTIVE row for the same number in
--      the same school — even if two requests race in the same millisecond.
--      'departed'/'no_show' rows are excluded, so a number can be reused
--      after its car has left, exactly matching the artifact's semantics.
--   3. Tenant lookup indexes for the 3-second getState poll.
--
-- Numbers only: there is deliberately NO name/roster/photo column anywhere.

CREATE TABLE schools (
  id          TEXT PRIMARY KEY,              -- opaque tenant id (e.g. 'sch_' + random)
  join_code   TEXT NOT NULL UNIQUE,          -- shared staff code; maps to this school
  name        TEXT NOT NULL,
  district    TEXT NOT NULL DEFAULT '',
  county      TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT '',
  school_type TEXT NOT NULL DEFAULT 'elementary',
  dismissal_start TEXT NOT NULL DEFAULT '14:15',
  dismissal_end   TEXT NOT NULL DEFAULT '15:00',
  spots_per_wave  INTEGER NOT NULL DEFAULT 8,
  lane_mode   TEXT NOT NULL DEFAULT 'dual',  -- 'single' | 'dual'
  left_label  TEXT NOT NULL DEFAULT 'Left Line',
  right_label TEXT NOT NULL DEFAULT 'Right Line',
  created_at  INTEGER NOT NULL
);

CREATE TABLE waves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id   TEXT NOT NULL REFERENCES schools(id),
  lane        TEXT NOT NULL,                 -- 'left' | 'right' | 'main'
  number      INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'released'
  created_at  INTEGER NOT NULL,
  released_at INTEGER
);
CREATE INDEX waves_school_lane ON waves(school_id, lane, number);

CREATE TABLE car_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id   TEXT NOT NULL REFERENCES schools(id),
  number      TEXT NOT NULL,
  lane        TEXT NOT NULL,
  wave_id     INTEGER NOT NULL REFERENCES waves(id),
  spot        INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'entered',
              -- 'entered' | 'on_board' | 'at_spot' | 'loaded' | 'departed' | 'no_show'
  entered_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX car_entries_school ON car_entries(school_id, id);
CREATE INDEX car_entries_wave ON car_entries(wave_id);

-- THE duplicate guard, enforced by the database engine itself:
CREATE UNIQUE INDEX car_entries_one_active_per_number
  ON car_entries(school_id, number)
  WHERE status NOT IN ('departed', 'no_show');

CREATE TABLE holds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id   TEXT NOT NULL REFERENCES schools(id),
  number      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(school_id, number)
);

CREATE TABLE day_summaries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id    TEXT NOT NULL REFERENCES schools(id),
  total_loaded INTEGER NOT NULL,
  total_no_show INTEGER NOT NULL,
  waves_run    INTEGER NOT NULL,
  total_holds  INTEGER NOT NULL DEFAULT 0,   -- Proof Report: holds PLACED that day
  still_waiting INTEGER NOT NULL DEFAULT 0,  -- Proof Report: active at End Dismissal
  started_at   INTEGER,                      -- Proof Report: first entry of the day
  first_car_at INTEGER,
  last_car_at  INTEGER,
  ended_at     INTEGER NOT NULL
);
CREATE INDEX day_summaries_school ON day_summaries(school_id, id);

-- Live dismissal-session bookkeeping (per school): created by the day's
-- first entry (or first hold) after the previous End Dismissal, consumed
-- and cleared by endDismissal into that day's summary. Counts only —
-- holds no car numbers. Mirrors the artifact's dismissal_session table.
CREATE TABLE dismissal_session (
  school_id    TEXT PRIMARY KEY REFERENCES schools(id),
  started_at   INTEGER,
  holds_placed INTEGER NOT NULL DEFAULT 0
);
