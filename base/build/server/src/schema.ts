// RiderTap schema — numbers only. Six objects, zero students:
// School profile, Lane (config on school), Entry, Wave, Hold, Day Summary.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const school = sqliteTable("school", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  district: text("district").notNull().default(""),
  county: text("county").notNull().default(""),
  state: text("state").notNull().default(""),
  schoolType: text("school_type").notNull().default("elementary"),
  dismissalStart: text("dismissal_start").notNull().default("14:15"),
  dismissalEnd: text("dismissal_end").notNull().default("15:00"),
  spotsPerWave: integer("spots_per_wave").notNull().default(8),
  laneMode: text("lane_mode", { enum: ["single", "dual"] })
    .notNull()
    .default("dual"),
  leftLabel: text("left_label").notNull().default("Left Line"),
  rightLabel: text("right_label").notNull().default("Right Line"),
});

export const waves = sqliteTable("waves", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lane: text("lane").notNull(), // 'left' | 'right' | 'main'
  number: integer("number").notNull(),
  status: text("status", { enum: ["open", "released"] })
    .notNull()
    .default("open"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  releasedAt: integer("released_at", { mode: "timestamp_ms" }),
});

export const carEntries = sqliteTable("car_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  number: text("number").notNull(),
  lane: text("lane").notNull(),
  waveId: integer("wave_id").notNull(),
  spot: integer("spot").notNull(),
  status: text("status", {
    enum: ["entered", "on_board", "at_spot", "loaded", "departed", "no_show"],
  })
    .notNull()
    .default("entered"),
  enteredAt: integer("entered_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const holds = sqliteTable("holds", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  number: text("number").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const daySummaries = sqliteTable("day_summaries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  totalLoaded: integer("total_loaded").notNull(),
  totalNoShow: integer("total_no_show").notNull(),
  wavesRun: integer("waves_run").notNull(),
  firstCarAt: integer("first_car_at", { mode: "timestamp_ms" }),
  lastCarAt: integer("last_car_at", { mode: "timestamp_ms" }),
  endedAt: integer("ended_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  // Proof Report fields. startedAt is the timestamp of the day's FIRST
  // number entry; legacy summaries predate it and stay null (duration "—").
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  holdsPlaced: integer("holds_placed").notNull().default(0),
  stillWaiting: integer("still_waiting").notNull().default(0),
});

// Live dismissal-session bookkeeping: created by the first entry (or first
// hold) after the previous End Dismissal, consumed and cleared by
// endDismissal into that day's summary. Holds no numbers — counts only.
export const dismissalSession = sqliteTable("dismissal_session", {
  id: integer("id").primaryKey(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  holdsPlaced: integer("holds_placed").notNull().default(0),
});
