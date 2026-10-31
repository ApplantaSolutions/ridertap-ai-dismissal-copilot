// Copilot staging schema — the runtime source of truth (inlined so the
// bundled single-file function carries it; a schema.sql read from disk
// breaks the moment the function is bundled into dist/, which is exactly
// the failure this layout prevents — see BUILD-LOG Oct 27).
//
// libSQL / SQLite dialect — same as the base. Tenant registry mirrors the
// base: a school row + join code; every Copilot table is scoped by
// school_id. Seeded by scripts/seed.ts into a LOCAL file database
// (contingency C-12 stand-in for staging Turso); the same statements
// apply unchanged to a staging Turso instance when one exists.
//
// COUNT-ONLY PERSISTENCE (privacy architecture, non-negotiable): the zone
// tables store counts, expected counts, statuses and timestamps. There is
// NO image column, NO mask column, NO thumbnail column — a frame is held
// in function memory for the count and then discarded.
//
// Build 2 adds the board-state tables the exception agent reads (waves,
// the called queue, entries, holds — tag numbers and statuses only; the
// system has no student names or records, so none can exist here) and the
// exception tables: a per-call LOG of (trigger, source, latency, action)
// and the CURRENT open line per school. The instruction text persisted in
// copilot_exception_current contains tag numbers only — it is generated
// from the same tag-only board state and validated before it is stored.
//
// Build 3 adds the voice tables (PTT sessions, per-school voice state,
// and the voice-event log). Their privacy shape is the architecture's:
// resolved tags and outcomes only — no audio, no transcripts (see the
// note at the tables themselves).

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS copilot_schools (
  id            TEXT PRIMARY KEY,
  join_code     TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  lane_mode     TEXT NOT NULL DEFAULT 'dual',
  spots_per_wave INTEGER NOT NULL DEFAULT 4,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS copilot_zone_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id  TEXT NOT NULL,
  lane       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  source     TEXT NOT NULL,
  count      INTEGER NOT NULL,
  expected   INTEGER NOT NULL,
  status     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS copilot_zone_state (
  school_id       TEXT NOT NULL,
  lane            TEXT NOT NULL,
  expected        INTEGER NOT NULL DEFAULT 0,
  last_count      INTEGER,
  mismatch_streak INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'VERIFIED',
  flag_count      INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (school_id, lane)
);

CREATE TABLE IF NOT EXISTS copilot_waves (
  school_id  TEXT NOT NULL,
  id         TEXT NOT NULL,
  lane       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'called',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (school_id, id)
);

CREATE TABLE IF NOT EXISTS copilot_wave_queue (
  school_id TEXT NOT NULL,
  wave      TEXT NOT NULL,
  tag       TEXT NOT NULL,
  position  INTEGER NOT NULL,
  entered   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (school_id, wave, tag)
);

CREATE TABLE IF NOT EXISTS copilot_entries (
  school_id  TEXT NOT NULL,
  tag        TEXT NOT NULL,
  lane       TEXT NOT NULL,
  wave       TEXT NOT NULL,
  spot       INTEGER,
  status     TEXT NOT NULL DEFAULT 'entered',
  walk_up    INTEGER NOT NULL DEFAULT 0,
  attempts   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (school_id, tag)
);

CREATE TABLE IF NOT EXISTS copilot_holds (
  school_id TEXT NOT NULL,
  tag       TEXT NOT NULL,
  placed_at INTEGER NOT NULL,
  PRIMARY KEY (school_id, tag)
);

CREATE TABLE IF NOT EXISTS copilot_exception_current (
  school_id   TEXT PRIMARY KEY,
  trigger     TEXT NOT NULL,
  instruction TEXT NOT NULL,
  action      TEXT NOT NULL,
  source      TEXT NOT NULL,
  latency_ms  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS copilot_exception_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id  TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  trigger    TEXT NOT NULL,
  source     TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  action     TEXT NOT NULL
);

-- Build 3 (voice entry) tables. VOICE PRIVACY (architecture, graded):
-- walker audio is transcribed and DISCARDED, and transcripts are never
-- stored either. copilot_voice_log is the voice-event log — school,
-- lane, the RESOLVED tag (or NULL), and the outcome
-- (matched | corrected | repeat | held — 'held' added Oct 30 when HOLD
-- became a hard block at entry) — and nothing else: there is NO audio
-- column, NO transcript column, NO raw-text column anywhere in this
-- schema, and copilot_voice_state holds only tags (pending CONFIRM pair
-- and its kind — 'suggest' | 'readback', Fri Oct 30 battery Fix 1 —
-- last entered tag for the read-back) and counters.
CREATE TABLE IF NOT EXISTS copilot_voice_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id    TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  lane         TEXT NOT NULL,
  resolved_tag TEXT,
  outcome      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS copilot_voice_state (
  school_id        TEXT PRIMARY KEY,
  pending_tag      TEXT,
  pending_suggested TEXT,
  pending_kind     TEXT,
  pending_lane     TEXT,
  pending_wave     TEXT,
  last_tag         TEXT,
  last_outcome     TEXT,
  repeat_value     TEXT,
  repeat_count     INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS copilot_voice_sessions (
  token      TEXT PRIMARY KEY,
  school_id  TEXT NOT NULL,
  lane       TEXT NOT NULL,
  language   TEXT NOT NULL DEFAULT 'en',
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
`;
