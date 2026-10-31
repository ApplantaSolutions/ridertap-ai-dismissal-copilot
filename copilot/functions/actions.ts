// RiderTap COPILOT actions function — Build 1 (Tue Oct 27, 2026) +
// Build 2 exception-agent wiring + Build 3 voice entry (Wed Oct 28, 2026).
//
// Shape: ONE Netlify Function ("actions") dispatching on
// {action, args, schoolCode} — identical to the frozen base (R-06), so
// the deploy pattern, the local harness, and the client transport all
// carry over unchanged. Exports BOTH a fetch-style default handler (local
// harness) and a Lambda-style `handler` (what the bundled Netlify zip
// invokes), exactly like production.
//
// NO function reads from a device (R-07): every input arrives in the
// request payload. Replay mode is therefore the same code path fed
// recorded payloads — a harness, not a feature.
//
// Actions (Build 1):
//   health       — no tenant needed; answers service + adapter + DB state.
//   zoneCheck    — one cropped still (test-asset ID today; image bytes when
//                  the live SAM adapter lands) + expected count → count,
//                  debounce, count-only persistence, board status. When
//                  the debounce flag fires (2nd consecutive mismatch —
//                  never at streak 1, never on a match), the exception
//                  agent auto-fires `zone_mismatch` (Build 2). At streak 1
//                  (CHECKING) a speculative advise is computed and held
//                  in memory only — it surfaces nowhere unless the flag
//                  lands with an identical context (Oct 30 hardening).
//   getZoneStatus— board-facing per-lane chip state (VERIFIED/CHECKING/
//                  MISMATCH + count pair + flag episodes).
//   resetZone    — staging test support: clear zone state/checks per lane.
//
// Actions (Build 2 — board state + exception agent, EXCEPTION-SCRIPTS):
//   callWave / enterTag / setEntryStatus / setWaveStatus — the minimal
//     board the agent reads. enterTag fires `duplicate` when it hits the
//     duplicate guard and `out_of_order` on the EX-03 entry condition;
//     normal entry, status changes, wave release/loading/departure fire
//     NOTHING. HOLD is a hard block (Oct 30 hardening): enterTag on a
//     held tag returns { held: true } — a 200 safety outcome, no entry,
//     no agent call — and setEntryStatus refuses to ADVANCE a held tag
//     (on_board / at_spot / loaded / departed) with tag_on_hold (422).
//   placeHold    — inserts the human HOLD first (live immediately), THEN
//     fires `hold_placed` to inform the agent. removeHold fires nothing:
//     the agent is never in the hold path in either direction.
//   markWalkUp   — human flag: marks the entry walk-up, fires `walk_up`.
//   openSweep    — fires `no_show_candidate` only when the Still Waiting
//     sweep opens with unresolved called tags; otherwise no call.
//   getBoard / getException / resolveException — board reads + the human
//     confirm/dismiss tap (executes nothing else).
//   resetBoard   — staging test support: clear board + exception state.
//
// Actions (Build 3 — voice entry, VOICE-CASES):
//   startPtt / endPtt — the push-to-talk gate. An utterance is processed
//     ONLY inside an active session; ambient audio without PTT produces
//     zero entries, zero resolver events, zero log rows (VC-14).
//   voiceUtterance — one PTT utterance: a test clip ID for the stub
//     adapter, the PTT clip bytes (audioBase64) for the live adapter,
//     or a transcript injected at the test boundary → the closed-set
//     resolver's one outcome (MATCHED / CONFIRM / ASK-REPEAT /
//     DUPLICATE / HELD). CONFIRM enters nothing until voiceConfirm
//     answers; HELD enters nothing, ever, while the hold stands.
//   voiceConfirm  — the walker's YES/NO on a pending CONFIRM (YES enters
//     the named twin, logged `corrected`; NO enters nothing).
//   getVoiceState — pending CONFIRM prompt, the last entered tag
//     (read-back), the last outcome.
//   voiceUndo     — one-tap removal of the last voice entry (VC-06).
//
// Environment (Netlify env vars on the STAGING site only — never in
// source, never in chat):
//   COPILOT_DB_URL / COPILOT_DB_TOKEN — explicit DB override (the gate
//     harnesses force a local file here); otherwise TURSO_DATABASE_URL /
//     TURSO_AUTH_TOKEN name the persistent staging DB (C-12); otherwise
//     a local file is used.
//   COPILOT_SAM_ADAPTER / COPILOT_SPARK_ADAPTER /
//   COPILOT_TRANSCRIBE_ADAPTER — "live" (default) | "stub". The scenario
//     harnesses force "stub"; staging runs the live adapters. A live
//     adapter with no key, or a failed live call, fails closed (the
//     degrade paths in src/sam.ts / src/spark.ts / src/transcribe.ts).
//   META_API_KEY — set by JR on the staging site (done Oct 29). The live
//     adapters read it from env only; it never appears in source.

import { dbKind, ensureSchema, resolveSchool } from "../src/db";
import { ZoneChecker } from "../src/zone";
import { ExceptionService, PayloadHygieneError } from "../src/exceptions";
import { VoiceService, PttRequiredError } from "../src/voice";
import * as board from "../src/board";
import { TagOnHoldError } from "../src/board";

const checker = new ZoneChecker();
const exceptions = new ExceptionService();
const voice = new VoiceService();

type Handler = (schoolId: string, args: any) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  async zoneCheck(schoolId, args) {
    const result = await checker.check(schoolId, {
      lane: String(args?.lane ?? "main"),
      expected: Number(args?.expected ?? 0),
      stillId: args?.stillId ? String(args.stillId) : undefined,
      imageBase64: args?.imageBase64 ? String(args.imageBase64) : undefined,
    });
    // Build 2 trigger: the agent fires ONLY at the flag moment — the
    // still that transitions the lane into MISMATCH (the 2nd consecutive
    // mismatching still). flagRaised is exactly that transition: a match
    // and a first (CHECKING) mismatch both leave it false, and a
    // continuing mismatch episode does not re-fire.
    if (result.flagRaised) {
      const payload = await board.buildExceptionPayload(schoolId, {
        trigger: "zone_mismatch",
        zone: {
          lane: result.lane,
          count: result.count,
          expected: result.expected,
          consecutiveMismatches: result.streak,
        },
      });
      const exception = await exceptions.advise(schoolId, payload);
      return { ...result, exception };
    }
    // Latency hardening (Oct 30): Spark's median on this trigger sits at
    // the 3s cap's edge, so the wait starts BEFORE the flag exists. At
    // CHECKING (streak 1), fire a SPECULATIVE advise against the
    // projected flag payload and cache the validated line in memory;
    // advise() serves it at the flag only if the live context still
    // matches field-by-field, and the response here gains NOTHING — no
    // exception key, no log row, no surface opens at CHECKING. A match
    // (VERIFIED) discards the cached line. The whole block is advisory
    // optimization: it must never break the zone pipeline, so it is
    // wrapped and the service method itself never throws.
    if (result.status === "CHECKING") {
      try {
        const payload = await board.buildExceptionPayload(schoolId, {
          trigger: "zone_mismatch",
          zone: {
            lane: result.lane,
            count: result.count,
            expected: result.expected,
            consecutiveMismatches: result.streak,
          },
        });
        await exceptions.prefetchZoneMismatch(schoolId, payload);
      } catch {
        // The flag path re-builds and re-validates loudly; silence here.
      }
    } else if (result.status === "VERIFIED") {
      exceptions.discardPrefetch(schoolId, result.lane);
    }
    return result;
  },

  async getZoneStatus(schoolId) {
    return checker.boardStatus(schoolId);
  },

  async resetZone(schoolId, args) {
    return checker.reset(schoolId, args?.lane ? String(args.lane) : undefined);
  },

  // ------------------------------------------------------- Build 2 ---
  async callWave(schoolId, args) {
    return board.callWave(schoolId, {
      id: String(args?.id ?? ""),
      lane: String(args?.lane ?? "main"),
      tags: Array.isArray(args?.tags) ? args.tags.map(String) : [],
    });
  },

  async enterTag(schoolId, args) {
    const outcome = await board.enterTag(schoolId, {
      tag: String(args?.tag ?? ""),
      lane: String(args?.lane ?? "main"),
      wave: String(args?.wave ?? ""),
      spot: args?.spot != null ? Number(args.spot) : undefined,
    });
    if (outcome.kind === "duplicate") {
      // The duplicate guard held: no second entry exists. Inform the
      // agent so the lead gets the "first entry stands" line.
      const payload = await board.buildExceptionPayload(schoolId, {
        trigger: "duplicate",
        entry: outcome.entry,
        attemptedLane: String(args?.lane ?? outcome.entry.lane),
        attemptCount: outcome.attemptCount,
      });
      const exception = await exceptions.advise(schoolId, payload);
      return { ok: false, duplicate: true, entry: outcome.entry, exception };
    }
    if (outcome.kind === "held") {
      // HOLD hard block (Oct 30 safety hardening): a normal 200 safety
      // outcome like `duplicate`, NOT an error — the tag is on a
      // human-placed hold, nothing was entered, and no agent line
      // fires. The hold itself is the whole message.
      return { ok: false, held: true, tag: outcome.tag };
    }
    if (outcome.skippedTag) {
      const payload = await board.buildExceptionPayload(schoolId, {
        trigger: "out_of_order",
        waveId: outcome.entry.wave,
        arrivedTag: outcome.entry.tag,
        skippedTag: outcome.skippedTag,
      });
      const exception = await exceptions.advise(schoolId, payload);
      return { ok: true, entry: outcome.entry, exception };
    }
    return { ok: true, entry: outcome.entry };
  },

  async setEntryStatus(schoolId, args) {
    // Normal loading flow (on_board / at_spot / loaded / departed) —
    // never an agent trigger. Advancing a HELD tag throws tag_on_hold
    // in the board layer → 422 below: a hold blocks progression too.
    return board.setEntryStatus(schoolId, {
      tag: String(args?.tag ?? ""),
      status: String(args?.status ?? ""),
    });
  },

  async setWaveStatus(schoolId, args) {
    // Normal wave release / loading transitions — never an agent trigger.
    return board.setWaveStatus(schoolId, {
      wave: String(args?.wave ?? ""),
      status: String(args?.status ?? ""),
    });
  },

  async placeHold(schoolId, args) {
    // ORDER IS THE CONTRACT (EX-05/EX-06): the hold is inserted — live
    // on the board — FIRST. Only then is the agent informed. If the
    // agent is slow or down, the hold stands exactly the same.
    const placed = await board.placeHold(schoolId, { tag: String(args?.tag ?? "") });
    const payload = await board.buildExceptionPayload(schoolId, {
      trigger: "hold_placed",
      tag: String(args?.tag ?? ""),
    });
    const exception = await exceptions.advise(schoolId, payload);
    return {
      ...placed,
      holdPlacedAt: new Date(placed.placedAt).toISOString(),
      exception,
    };
  },

  async removeHold(schoolId, args) {
    // No agent call — the agent is never in the hold path, either way.
    return board.removeHold(schoolId, { tag: String(args?.tag ?? "") });
  },

  async markWalkUp(schoolId, args) {
    // Human flag only — vision counts vehicles and never triggers this.
    const entry = await board.markWalkUp(schoolId, { tag: String(args?.tag ?? "") });
    const payload = await board.buildExceptionPayload(schoolId, {
      trigger: "walk_up",
      entry,
    });
    const exception = await exceptions.advise(schoolId, payload);
    return { ok: true, entry, exception };
  },

  async openSweep(schoolId) {
    const sweep = await board.stillWaiting(schoolId);
    if (sweep.tags.length === 0) {
      // No unresolved called tags → no call, no line.
      return { ok: true, stillWaiting: [], exception: null };
    }
    const payload = await board.buildExceptionPayload(schoolId, {
      trigger: "no_show_candidate",
      tags: sweep.tags,
      entries: sweep.entries,
      wavesCompleted: sweep.wavesCompleted,
    });
    const exception = await exceptions.advise(schoolId, payload);
    return { ok: true, stillWaiting: sweep.tags, exception };
  },

  async getBoard(schoolId) {
    return board.getBoard(schoolId);
  },

  async getException(schoolId) {
    return { current: await exceptions.current(schoolId) };
  },

  async resolveException(schoolId, args) {
    const resolution = args?.resolution === "dismissed" ? "dismissed" : "confirmed";
    return exceptions.resolve(schoolId, resolution);
  },

  async resetBoard(schoolId) {
    return board.resetBoard(schoolId);
  },

  // ------------------------------------------------------- Build 3 ---
  async startPtt(schoolId, args) {
    return voice.startSession(schoolId, {
      lane: String(args?.lane ?? "main"),
      language: args?.language ? String(args.language) : undefined,
    });
  },

  async endPtt(schoolId, args) {
    return voice.endSession(schoolId, { token: String(args?.token ?? "") });
  },

  async voiceUtterance(schoolId, args) {
    return voice.utterance(schoolId, {
      token: args?.token ? String(args.token) : null,
      lane: args?.lane ? String(args.lane) : undefined,
      clipId: args?.clipId ? String(args.clipId) : undefined,
      audioBase64: args?.audioBase64 ? String(args.audioBase64) : undefined,
      transcript: args?.transcript != null ? String(args.transcript) : undefined,
      language: args?.language ? String(args.language) : undefined,
    });
  },

  async voiceConfirm(schoolId, args) {
    return voice.confirm(schoolId, {
      yes: args?.yes === true,
      language: args?.language ? String(args.language) : undefined,
    });
  },

  async getVoiceState(schoolId, args) {
    return voice.state(schoolId, {
      language: args?.language ? String(args.language) : undefined,
    });
  },

  async voiceUndo(schoolId) {
    return voice.undoLast(schoolId);
  },
};

async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  let body: { action?: string; args?: unknown; schoolCode?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }

  if (body.action === "health") {
    let dbOk = true;
    try {
      await ensureSchema();
    } catch {
      dbOk = false;
    }
    return Response.json({
      ok: dbOk,
      service: "ridertap-copilot",
      build: "build-2-exception-agent",
      samAdapter: checker.adapterKind,
      samModel: checker.modelId,
      sparkAdapter: exceptions.adapterKind,
      sparkModel: exceptions.modelId,
      transcribeAdapter: voice.adapterKind,
      transcribeModel: voice.modelId,
      db: dbOk ? `connected (${dbKind})` : "error",
      ts: new Date().toISOString(),
    });
  }

  const handler = body.action ? handlers[body.action] : undefined;
  if (!handler) {
    return Response.json({ error: "unknown_action" }, { status: 400 });
  }
  if (!body.schoolCode) {
    return Response.json({ error: "school_code_required" }, { status: 401 });
  }
  const school = await resolveSchool(body.schoolCode);
  if (!school) {
    return Response.json({ error: "unknown_school" }, { status: 403 });
  }
  try {
    const result = await handler(school.id, body.args ?? {});
    return Response.json(result);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    // Adapter errors are configuration/input errors, surfaced as such —
    // never a 500 that looks like a crash and never a silent fake count.
    // A payload-hygiene failure is the same class: the case fails on
    // sight, by name, and nothing was logged or displayed.
    if (
      e instanceof PayloadHygieneError ||
      e instanceof PttRequiredError ||
      e instanceof TagOnHoldError ||
      msg.startsWith("tag_on_hold") ||
      msg.startsWith("stub_adapter_") ||
      msg.startsWith("live_adapter_error") ||
      msg.startsWith("live_adapter_not_enabled") ||
      msg.startsWith("contributor_model_forbidden") ||
      msg.startsWith("walk_up_unknown_tag") ||
      msg.startsWith("wave_id_invalid") ||
      msg.startsWith("unknown COPILOT_SAM_ADAPTER") ||
      msg.startsWith("unknown COPILOT_SPARK_ADAPTER") ||
      msg.startsWith("unknown COPILOT_TRANSCRIBE_ADAPTER")
    ) {
      return Response.json({ error: msg }, { status: 422 });
    }
    console.error("copilot action failed", body.action, e);
    return Response.json({ error: "internal" }, { status: 500 });
  }
}

export default handleRequest;

// Netlify Functions (classic Lambda) entry — same adapter as the base:
// API-Gateway-shaped event onto the fetch-style core handler.
export const handler = async (event: {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
}): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> => {
  const raw = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body
    : "";
  const method = event.httpMethod ?? "POST";
  const req = new Request("https://ridertap-copilot.internal/api/actions", {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? raw : undefined,
  });
  const res = await handleRequest(req);
  return {
    statusCode: res.status,
    headers: { "content-type": "application/json" },
    body: await res.text(),
  };
};
