// Voice service — Build 3 (voice entry), Wed Oct 28, 2026.
//
// Contract (test-assets/VOICE-CASES.md, the acceptance source):
//   pipeline — walker PUSH-TO-TALK → Muse Voice Transcribe (keyword
//             biasing toward the in-play tags) → transcript → CLOSED-SET
//             resolver over the LIVE board (src/board.ts laneBoardState).
//   outcomes — MATCHED / CONFIRM / ASK-REPEAT / DUPLICATE, plus HELD
//             (Oct 30 safety hardening): an utterance that resolves to
//             a tag under a human HOLD enters NOTHING and tells the
//             walker so, plainly. Never guess into the set, never
//             auto-correct a non-set tag without CONFIRM, never enter
//             on a partial, never double-queue, never enter a held
//             tag. A wrong entry is worse than a repeat.
//   PTT gate — an utterance exists ONLY inside an active push-to-talk
//             session. Ambient audio without PTT is not transcribed,
//             not resolved, and not logged: zero entries, zero resolver
//             events, zero log rows (VC-14 is an auto-fail otherwise).
//   privacy  — audio is transcribed and discarded; transcripts live in
//             function memory for the resolution and are NEVER
//             persisted. The voice-event log stores only school, lane,
//             the resolved tag (or none), and the outcome
//             (matched | corrected | repeat | held).
//
// CONFIRM semantics — two variants, one rule: when a digit-
// transposition twin makes an utterance ambiguous, NOTHING enters
// until the walker explicitly confirms. The pending pair is held
// server-side with its kind; the kind decides what YES enters.
//
//   suggest (VC-05/VC-19): a transcript that lands on an already-
//   active tag while a near-match twin is still live AHEAD of it in
//   the calling (queue) order asks "did you mean <twin>?" — naming
//   BOTH tags. The walker works the queue forward, so the plausible
//   intent behind re-saying an active tag is the upcoming twin they
//   meant to call next; YES enters the TWIN. A twin whose turn has
//   already passed is not a plausible intent — that re-say is a plain
//   duplicate (VC-10: 221 re-said with 212 behind it → DUPLICATE,
//   while VC-05's 345 re-said with 354 ahead of it → CONFIRM). A
//   duplicate with no live twin at all is VC-09: the board's own
//   duplicate path (the same enterTag guard + EX-04 exception the
//   typed path uses).
//
//   readback (Fri Oct 30, 100× battery Fix 1): a transcript that
//   resolves to a tag NOT yet entered, while a confusable tag is live
//   ANYWHERE in the closed set — any queue position, entered or not.
//   The battery proved the ASR itself flips twin pairs (354 heard as
//   "345" on ~1/3 of utterances), so a twin-live resolution is
//   ambiguous regardless of relative order: in the battery's
//   [354, 345] wave the misheard 345 entered silently because the old
//   rule only looked forward from an ACTIVE tag. The read-back names
//   BOTH tags and asks "enter <heard>?"; YES enters the HEARD tag.
//   Duplicate detection still fires FIRST — the active-tag branch
//   above runs before this check, so a re-said already-entered tag is
//   handled there (suggest/DUPLICATE), never by the read-back.
//
//   WIDENED (Fri Oct 30, JR-approved, hostile-voice battery): the
//   read-back guard's "twin" is now any CONFUSABLE tag — a digit
//   transposition OR one digit off (Hamming distance exactly 1). The
//   hostile battery's one true wrong entry was the second shape: a
//   hurried "one zero one" transcribed as the in-wave decoy 102, a
//   substitution the transposition-only guard could not see. When
//   several confusable tags are live, the prompt names the one
//   earliest in queue position. The suggest variant above is NOT
//   widened: it answers a re-say of an already-entered tag, where
//   duplicate detection governs and only a transposition twin ahead
//   makes "did you mean the next one?" the plausible reading.

import { randomUUID } from "node:crypto";
import { getDb, ensureSchema } from "./db";
import * as board from "./board";
import {
  selectTranscribeAdapter,
  type TranscribeAdapter,
} from "./transcribe";
import {
  normalizeTranscript,
  areNearMatch,
  areConfusable,
  type SpokenLanguage,
} from "./numbers";
import { ExceptionService, type ExceptionRecord } from "./exceptions";

export type VoiceOutcome = "MATCHED" | "CONFIRM" | "ASK-REPEAT" | "DUPLICATE" | "HELD";
export type VoiceLogOutcome = "matched" | "corrected" | "repeat" | "held";

export class PttRequiredError extends Error {
  constructor(reason: string) {
    super(`ptt_required: ${reason}`);
    this.name = "PttRequiredError";
  }
}

export interface VoiceUtteranceResult {
  outcome: VoiceOutcome;
  /** The tag the transcript resolved to (the spoken candidate), if any. */
  tag: string | null;
  /** The tag actually entered by this utterance (MATCHED only). */
  enteredTag: string | null;
  /** CONFIRM only: the in-set twin the walker is asked about. */
  suggestedTag?: string;
  /** CONFIRM only: the exact prompt shown to the walker. */
  prompt?: string;
  message: string;
  /** Language of THIS utterance, as detected (never session state). */
  language: SpokenLanguage;
  /** Language the walker-facing prompt/message is written in (app language). */
  promptLanguage: SpokenLanguage;
  /** Read-back: the last tag entered, shown prominently (VC-06 net). */
  readBack: string | null;
  /** ASK-REPEAT only: true once repeat failures direct the walker to type. */
  needsTyping?: boolean;
  /** Set when the board's exception agent fired alongside (EX-04 parity). */
  exception?: ExceptionRecord;
  transcribeSource?: "stub" | "live";
  transcribeModel?: string;
  /** The biasing vocabulary the transcribe call carried (the closed set). */
  biasedTags?: string[];
}

export interface VoiceStateView {
  pending: { tag: string; suggestedTag: string; prompt: string } | null;
  lastTag: string | null;
  lastOutcome: string | null;
}

/** Which CONFIRM variant a held pair is: YES enters the suggested
 *  twin ('suggest', VC-05/VC-19) or the heard tag ('readback', Fix 1). */
type PendingKind = "suggest" | "readback";

interface VoiceStateRow {
  pendingTag: string | null;
  pendingSuggested: string | null;
  pendingKind: PendingKind | null;
  pendingLane: string | null;
  pendingWave: string | null;
  lastTag: string | null;
  lastOutcome: string | null;
  repeatValue: string | null;
  repeatCount: number;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

// ------------------------------------------------------------ wording ---
// Prompts follow the APP language (the base's EN/ES toggle), never the
// detected utterance language — a code-switching walker still reads one
// consistent UI (VC-19's Spanish prompt comes from the ES app setting).
function laneEn(lane: string): string {
  return lane === "main" ? "Main" : lane.charAt(0).toUpperCase() + lane.slice(1);
}
function laneEsInPhrase(lane: string): string {
  // "…en la fila de la izquierda / de la derecha / principal"
  return lane === "left" ? "la izquierda" : lane === "right" ? "la derecha" : "la principal";
}
function confirmPrompt(lang: SpokenLanguage, tag: string, suggested: string, lane: string): string {
  return lang === "es"
    ? `${tag} ya está en la fila de ${laneEsInPhrase(lane)} — ¿quiso decir ${suggested}?`
    : `${tag} is already queued in ${laneEn(lane)} — did you mean ${suggested}?`;
}
/** Read-back variant (Fix 1): the heard tag is the one YES will enter,
 *  so the question asks about IT, naming the live twin as the reason. */
function readbackPrompt(lang: SpokenLanguage, tag: string, twin: string, lane: string): string {
  return lang === "es"
    ? `Escuché ${tag} — ${twin} también está en la fila de ${laneEsInPhrase(lane)}. ¿Registrar ${tag}?`
    : `I heard ${tag} — ${twin} is also queued in ${laneEn(lane)}. Enter ${tag}?`;
}
function askRepeatMessage(lang: SpokenLanguage, needsTyping: boolean): string {
  const base =
    lang === "es"
      ? "No escuché una etiqueta que coincida — repítala, por favor."
      : "Didn't catch a matching tag — say it again.";
  if (!needsTyping) return base;
  return (
    base +
    (lang === "es"
      ? " Si sigue sin coincidir, escriba la etiqueta o consulte con la oficina."
      : " If it keeps missing, type the tag or check with the office.")
  );
}
function duplicateMessage(lang: SpokenLanguage, tag: string): string {
  return lang === "es"
    ? `${tag} ya está en el tablero — queda la primera entrada.`
    : `${tag} is already on the board — the first entry stands.`;
}
function matchedMessage(lang: SpokenLanguage, tag: string): string {
  return lang === "es" ? `Etiqueta ${tag} registrada.` : `Entered ${tag}.`;
}
function heldMessage(lang: SpokenLanguage, tag: string): string {
  return lang === "es"
    ? `${tag} está en HOLD — no se registró. La oficina debe levantar el HOLD primero.`
    : `${tag} is on HOLD — it was not entered. The office has to clear the hold first.`;
}

// ------------------------------------------------------------- service ---

export class VoiceService {
  constructor(
    private adapter: TranscribeAdapter = selectTranscribeAdapter(),
    private exceptions: ExceptionService = new ExceptionService(),
  ) {}

  get adapterKind() {
    return this.adapter.kind;
  }
  get modelId() {
    return this.adapter.modelId;
  }

  // -------------------------------------------------------- PTT gate ---
  async startSession(
    schoolId: string,
    args: { lane: string; language?: string },
  ): Promise<{ token: string; lane: string; language: string }> {
    await ensureSchema();
    const token = randomUUID();
    const language = args.language === "es" ? "es" : "en";
    await getDb().execute({
      sql: `INSERT INTO copilot_voice_sessions (token, school_id, lane, language, started_at, ended_at)
            VALUES (?, ?, ?, ?, ?, NULL)`,
      args: [token, schoolId, args.lane, language, Date.now()],
    });
    return { token, lane: args.lane, language };
  }

  async endSession(
    schoolId: string,
    args: { token: string },
  ): Promise<{ ok: true }> {
    await ensureSchema();
    await getDb().execute({
      sql: "UPDATE copilot_voice_sessions SET ended_at = ? WHERE token = ? AND school_id = ?",
      args: [Date.now(), args.token, schoolId],
    });
    return { ok: true };
  }

  /**
   * The gate itself. Throws BEFORE any transcription, resolution,
   * logging, or state write when there is no live PTT session — ambient
   * audio leaves no trace of any kind (VC-14).
   */
  private async requireSession(
    schoolId: string,
    token: string | null | undefined,
  ): Promise<{ lane: string; language: string }> {
    await ensureSchema();
    if (!token) throw new PttRequiredError("no push-to-talk session token");
    const rows = (
      await getDb().execute({
        sql: "SELECT * FROM copilot_voice_sessions WHERE token = ?",
        args: [token],
      })
    ).rows;
    const s = rows[0];
    if (!s || String(s.school_id) !== schoolId) {
      throw new PttRequiredError("unknown push-to-talk session");
    }
    if (s.ended_at != null) {
      throw new PttRequiredError("push-to-talk session already ended");
    }
    return { lane: String(s.lane), language: String(s.language) };
  }

  // ---------------------------------------------------------- state ----
  private async stateRow(schoolId: string): Promise<VoiceStateRow> {
    await ensureSchema();
    const rows = (
      await getDb().execute({
        sql: "SELECT * FROM copilot_voice_state WHERE school_id = ?",
        args: [schoolId],
      })
    ).rows;
    const r = rows[0];
    if (!r) {
      return {
        pendingTag: null, pendingSuggested: null, pendingKind: null, pendingLane: null,
        pendingWave: null, lastTag: null, lastOutcome: null,
        repeatValue: null, repeatCount: 0,
      };
    }
    return {
      pendingTag: str(r.pending_tag),
      pendingSuggested: str(r.pending_suggested),
      // Rows written before the Fix 1 migration read NULL here; the
      // only variant that existed then is 'suggest'.
      pendingKind: (str(r.pending_kind) === "readback" ? "readback" : "suggest") as PendingKind,
      pendingLane: str(r.pending_lane),
      pendingWave: str(r.pending_wave),
      lastTag: str(r.last_tag),
      lastOutcome: str(r.last_outcome),
      repeatValue: str(r.repeat_value),
      repeatCount: num(r.repeat_count),
    };
  }

  private async saveState(schoolId: string, s: VoiceStateRow): Promise<void> {
    await getDb().execute({
      sql: `INSERT INTO copilot_voice_state
              (school_id, pending_tag, pending_suggested, pending_kind, pending_lane, pending_wave,
               last_tag, last_outcome, repeat_value, repeat_count, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(school_id) DO UPDATE SET
              pending_tag = excluded.pending_tag,
              pending_suggested = excluded.pending_suggested,
              pending_kind = excluded.pending_kind,
              pending_lane = excluded.pending_lane,
              pending_wave = excluded.pending_wave,
              last_tag = excluded.last_tag,
              last_outcome = excluded.last_outcome,
              repeat_value = excluded.repeat_value,
              repeat_count = excluded.repeat_count,
              updated_at = excluded.updated_at`,
      args: [
        schoolId, s.pendingTag, s.pendingSuggested, s.pendingKind, s.pendingLane, s.pendingWave,
        s.lastTag, s.lastOutcome, s.repeatValue, s.repeatCount, Date.now(),
      ],
    });
  }

  /** Voice-event log — the ONLY voice persistence: tag + outcome, nothing else. */
  private async logEvent(
    schoolId: string,
    lane: string,
    resolvedTag: string | null,
    outcome: VoiceLogOutcome,
  ): Promise<void> {
    await getDb().execute({
      sql: `INSERT INTO copilot_voice_log (school_id, ts, lane, resolved_tag, outcome)
            VALUES (?, ?, ?, ?, ?)`,
      args: [schoolId, Date.now(), lane, resolvedTag, outcome],
    });
  }

  // ------------------------------------------------------ resolution ---
  private async askRepeat(
    schoolId: string,
    lane: string,
    lang: SpokenLanguage,
    valueKey: string,
    detected: SpokenLanguage,
  ): Promise<VoiceUtteranceResult> {
    const s = await this.stateRow(schoolId);
    // Repeat tracking is per VALUE (the parsed digits), never per
    // transcript text — raw transcripts are not stored anywhere.
    const count = s.repeatValue === valueKey ? s.repeatCount + 1 : 1;
    // After two failed REPEATS of the same value (the third failed
    // utterance of it), direct the walker to type it / check the office.
    const needsTyping = count >= 3;
    await this.saveState(schoolId, { ...s, repeatValue: valueKey, repeatCount: count });
    await this.logEvent(schoolId, lane, null, "repeat");
    const st = await this.stateRow(schoolId);
    return {
      outcome: "ASK-REPEAT",
      tag: null,
      enteredTag: null,
      message: askRepeatMessage(lang, needsTyping),
      language: detected,
      promptLanguage: lang,
      readBack: st.lastTag,
      needsTyping,
    };
  }

  /**
   * The HELD outcome: the resolved tag is under a human HOLD, so
   * NOTHING is entered and the walker hears exactly that. The event
   * logs tag + outcome only, like every other voice event.
   */
  private async held(
    schoolId: string,
    lane: string,
    lang: SpokenLanguage,
    tag: string,
    detected: SpokenLanguage,
  ): Promise<VoiceUtteranceResult> {
    const s = await this.stateRow(schoolId);
    await this.saveState(schoolId, { ...s, repeatValue: null, repeatCount: 0 });
    await this.logEvent(schoolId, lane, tag, "held");
    return {
      outcome: "HELD",
      tag,
      enteredTag: null,
      message: heldMessage(lang, tag),
      language: detected,
      promptLanguage: lang,
      readBack: s.lastTag,
    };
  }

  /** The board's duplicate path — identical to a typed duplicate (EX-04). */
  private async duplicate(
    schoolId: string,
    lane: string,
    lang: SpokenLanguage,
    tag: string,
    detected: SpokenLanguage,
  ): Promise<VoiceUtteranceResult> {
    const bs = await board.laneBoardState(schoolId, lane);
    const wave = bs.activeEntries.find((e) => e.tag === tag)?.wave ?? bs.waveId ?? "";
    const outcome = await board.enterTag(schoolId, { tag, lane, wave });
    if (outcome.kind === "held") {
      // The tag was entered BEFORE its hold landed, so the board's
      // hold check fires first: no attempt was counted and no
      // duplicate exception fires. What the walker needs is the hold
      // — it is the fact that governs this tag now.
      return this.held(schoolId, lane, lang, tag, detected);
    }
    let exception: ExceptionRecord | undefined;
    if (outcome.kind === "duplicate") {
      const payload = await board.buildExceptionPayload(schoolId, {
        trigger: "duplicate",
        entry: outcome.entry,
        attemptedLane: lane,
        attemptCount: outcome.attemptCount,
      });
      exception = await this.exceptions.advise(schoolId, payload);
    }
    const s = await this.stateRow(schoolId);
    await this.saveState(schoolId, { ...s, repeatValue: null, repeatCount: 0 });
    await this.logEvent(schoolId, lane, tag, "repeat");
    return {
      outcome: "DUPLICATE",
      tag,
      enteredTag: null,
      message: duplicateMessage(lang, tag),
      language: detected,
      promptLanguage: lang,
      readBack: s.lastTag,
      exception,
    };
  }

  async utterance(
    schoolId: string,
    args: {
      token?: string | null;
      lane?: string;
      clipId?: string;
      /** The walker's PTT clip (base64 WAV) — the live adapter's input. */
      audioBase64?: string;
      /** Test boundary: an injected transcript, used INSTEAD of the adapter. */
      transcript?: string;
      language?: string;
    },
  ): Promise<VoiceUtteranceResult> {
    // 1. PTT gate — first, before anything else can happen.
    const session = await this.requireSession(schoolId, args.token);
    const appLang: SpokenLanguage =
      (args.language === "es" || args.language === "en"
        ? args.language
        : session.language === "es"
          ? "es"
          : "en") as SpokenLanguage;
    let lane = args.lane ?? session.lane;

    // 2. Board state for the lane → the closed set (also the biasing list).
    let bs = await board.laneBoardState(schoolId, lane);

    // 3. Transcript: injected at the test boundary, or via the adapter.
    let transcript: string;
    let hint: SpokenLanguage = appLang;
    let transcribeSource: "stub" | "live" | undefined;
    let transcribeModel: string | undefined;
    let biasedTags: string[] | undefined;
    if (args.transcript != null) {
      transcript = args.transcript;
    } else {
      let r: Awaited<ReturnType<TranscribeAdapter["transcribe"]>> | null = null;
      try {
        r = await this.adapter.transcribe({
          clipId: args.clipId,
          audioBase64: args.audioBase64,
          lane,
          biasedTags: bs.closedSet,
          language: appLang,
        });
      } catch (e) {
        // FAIL CLOSED (live path): a transcription failure — no key, an
        // HTTP error, a timeout — must never fabricate a transcript and
        // never crash the walker's screen. The safe product behavior is
        // the ASK-REPEAT path (whose repeat counter escalates to
        // type-it/office after the third failure). The stub's throws are
        // graded test-surface errors and keep propagating unchanged.
        if (this.adapter.kind !== "live") throw e;
        const repeat = await this.askRepeat(schoolId, lane, appLang, "(unheard)", appLang);
        return {
          ...repeat,
          transcribeSource: "live",
          transcribeModel: this.adapter.modelId,
          biasedTags: bs.closedSet,
        };
      }
      transcript = r.transcript;
      hint = r.language;
      transcribeSource = r.source;
      transcribeModel = r.modelId;
      biasedTags = r.biasedTags;
    }

    // 4. Normalize (per-utterance language; a lane callout re-routes).
    const norm = normalizeTranscript(transcript, hint);
    if (norm.lane && norm.lane !== lane) {
      lane = norm.lane;
      bs = await board.laneBoardState(schoolId, lane);
    }
    const detected = norm.language;
    const extra = { transcribeSource, transcribeModel, biasedTags };

    // 5. Resolve — exactly four outcomes.
    if (norm.tag === null) {
      // Partial / garbled / unparseable: resolves to NOTHING.
      const r = await this.askRepeat(
        schoolId, lane, appLang, norm.digits ?? "(unparsed)", detected,
      );
      return { ...r, ...extra };
    }
    const tag = norm.tag;
    if (!bs.closedSet.includes(tag)) {
      // Not in the live set: never a guess, never a silent correction.
      const r = await this.askRepeat(schoolId, lane, appLang, tag, detected);
      return { ...r, ...extra };
    }
    const activeTags = new Set(bs.activeEntries.map((e) => e.tag));
    if (activeTags.has(tag)) {
      // Forward twins only (see header): candidates are the unentered
      // in-set tags positioned AFTER the spoken tag in calling order.
      const myIndex = bs.closedSet.indexOf(tag);
      const twin = bs.closedSet
        .slice(myIndex + 1)
        .find((t) => !activeTags.has(t) && areNearMatch(tag, t));
      if (twin) {
        // CONFIRM (suggest): hold the pair server-side; enter NOTHING yet.
        const active = bs.activeEntries.find((e) => e.tag === tag)!;
        const s = await this.stateRow(schoolId);
        await this.saveState(schoolId, {
          ...s,
          pendingTag: tag,
          pendingSuggested: twin,
          pendingKind: "suggest",
          pendingLane: lane,
          pendingWave: active.wave,
        });
        return {
          outcome: "CONFIRM",
          tag,
          enteredTag: null,
          suggestedTag: twin,
          prompt: confirmPrompt(appLang, tag, twin, lane),
          message: confirmPrompt(appLang, tag, twin, lane),
          language: detected,
          promptLanguage: appLang,
          readBack: s.lastTag,
          ...extra,
        };
      }
      const r = await this.duplicate(schoolId, lane, appLang, tag, detected);
      return { ...r, ...extra };
    }

    // HOLD HARD BLOCK (Oct 30 safety hardening): a held tag never
    // enters and never even asks CONFIRM — there is nothing to
    // confirm. (The board's own check inside enterTag is the backstop
    // for a hold that lands mid-resolution; this check is what keeps
    // a held tag out of the CONFIRM flow entirely.)
    if (await board.isTagHeld(schoolId, tag)) {
      const r = await this.held(schoolId, lane, appLang, tag, detected);
      return { ...r, ...extra };
    }

    // READ-BACK CONFIRM (Fix 1, widened Oct 30) — in set, not active,
    // but a CONFUSABLE tag (digit transposition or one digit off) is
    // live anywhere in the closed set: the ASR confuses both shapes,
    // so this resolution is ambiguous in ANY queue position. Hold the
    // pair; enter NOTHING until the walker confirms the heard tag.
    // The prompt names the confusable tag earliest in queue position
    // (closedSet is built in calling order). (Duplicate detection has
    // already fired above — an active tag never reaches this branch.)
    const liveNear = bs.closedSet.find((t) => t !== tag && areConfusable(tag, t));
    if (liveNear && bs.waveId) {
      const s = await this.stateRow(schoolId);
      await this.saveState(schoolId, {
        ...s,
        pendingTag: tag,
        pendingSuggested: liveNear,
        pendingKind: "readback",
        pendingLane: lane,
        pendingWave: bs.waveId,
      });
      const prompt = readbackPrompt(appLang, tag, liveNear, lane);
      return {
        outcome: "CONFIRM",
        tag,
        enteredTag: null,
        suggestedTag: liveNear,
        prompt,
        message: prompt,
        language: detected,
        promptLanguage: appLang,
        readBack: s.lastTag,
        ...extra,
      };
    }

    // MATCHED — in set, not active, no live confusable tag: enter
    // once, through the board path.
    if (!bs.waveId) {
      const r = await this.askRepeat(schoolId, lane, appLang, tag, detected);
      return { ...r, ...extra };
    }
    const outcome = await board.enterTag(schoolId, { tag, lane, wave: bs.waveId });
    if (outcome.kind === "held") {
      // A hold landed between the resolver's hold check and the board
      // write — the board refused the entry; nothing was written.
      const r = await this.held(schoolId, lane, appLang, tag, detected);
      return { ...r, ...extra };
    }
    if (outcome.kind === "duplicate") {
      // Lost a race with the typed path — same handling as any duplicate.
      const r = await this.duplicate(schoolId, lane, appLang, tag, detected);
      return { ...r, ...extra };
    }
    let exception: ExceptionRecord | undefined;
    if (outcome.skippedTag) {
      // Typed-path parity: an out-of-order voice entry informs the agent.
      const payload = await board.buildExceptionPayload(schoolId, {
        trigger: "out_of_order",
        waveId: outcome.entry.wave,
        arrivedTag: outcome.entry.tag,
        skippedTag: outcome.skippedTag,
      });
      exception = await this.exceptions.advise(schoolId, payload);
    }
    const s = await this.stateRow(schoolId);
    await this.saveState(schoolId, {
      ...s,
      pendingTag: null, pendingSuggested: null, pendingKind: null, pendingLane: null, pendingWave: null,
      lastTag: tag, lastOutcome: "matched", repeatValue: null, repeatCount: 0,
    });
    await this.logEvent(schoolId, lane, tag, "matched");
    return {
      outcome: "MATCHED",
      tag,
      enteredTag: tag,
      message: matchedMessage(appLang, tag),
      language: detected,
      promptLanguage: appLang,
      readBack: tag,
      exception,
      ...extra,
    };
  }

  /** Walker answers a pending CONFIRM. Nothing is entered before this. */
  async confirm(
    schoolId: string,
    args: { yes: boolean; language?: string },
  ): Promise<{
    ok: boolean;
    entered: string | null;
    outcome: "corrected" | "cancelled" | "none" | "held";
    /** The tag a HELD outcome refused to enter (client renders it). */
    tag?: string;
    readBack: string | null;
    exception?: ExceptionRecord;
  }> {
    const s = await this.stateRow(schoolId);
    if (!s.pendingTag || !s.pendingSuggested || !s.pendingLane || !s.pendingWave) {
      return { ok: false, entered: null, outcome: "none", readBack: s.lastTag };
    }
    const { pendingTag: heard, pendingSuggested: suggested, pendingLane: lane, pendingWave: wave } = s;
    // The held pair's kind decides what YES enters: 'suggest' → the
    // twin the walker plausibly meant (VC-05/VC-19); 'readback' → the
    // heard tag itself, now explicitly confirmed (Fix 1).
    const enterTag = s.pendingKind === "readback" ? heard : suggested;
    const cleared: VoiceStateRow = {
      ...s, pendingTag: null, pendingSuggested: null, pendingKind: null, pendingLane: null, pendingWave: null,
    };
    if (!args.yes) {
      await this.saveState(schoolId, cleared);
      await this.logEvent(schoolId, lane, null, "repeat");
      return { ok: true, entered: null, outcome: "cancelled", readBack: s.lastTag };
    }
    const outcome = await board.enterTag(schoolId, { tag: enterTag, lane, wave });
    if (outcome.kind === "held") {
      // A HOLD landed on the target while the CONFIRM was pending:
      // YES cannot enter it — the board wrote nothing. The pair
      // clears and the walker is told the tag is held, never that it
      // was entered or merely cancelled.
      await this.saveState(schoolId, cleared);
      await this.logEvent(schoolId, lane, enterTag, "held");
      return { ok: true, entered: null, outcome: "held", tag: enterTag, readBack: s.lastTag };
    }
    if (outcome.kind === "duplicate") {
      await this.saveState(schoolId, cleared);
      return { ok: true, entered: null, outcome: "cancelled", readBack: s.lastTag };
    }
    let exception: ExceptionRecord | undefined;
    if (outcome.skippedTag) {
      const payload = await board.buildExceptionPayload(schoolId, {
        trigger: "out_of_order",
        waveId: outcome.entry.wave,
        arrivedTag: outcome.entry.tag,
        skippedTag: outcome.skippedTag,
      });
      exception = await this.exceptions.advise(schoolId, payload);
    }
    await this.saveState(schoolId, {
      ...cleared, lastTag: enterTag, lastOutcome: "corrected",
      repeatValue: null, repeatCount: 0,
    });
    await this.logEvent(schoolId, lane, enterTag, "corrected");
    return { ok: true, entered: enterTag, outcome: "corrected", readBack: enterTag, exception };
  }

  /** One-tap Undo of the last voice entry (VC-06's safety net). */
  async undoLast(
    schoolId: string,
  ): Promise<{ ok: true; removedTag: string | null }> {
    const s = await this.stateRow(schoolId);
    if (!s.lastTag) return { ok: true, removedTag: null };
    const res = await board.removeEntry(schoolId, { tag: s.lastTag });
    if (res.removed) {
      await this.saveState(schoolId, { ...s, lastTag: null, lastOutcome: null });
      return { ok: true, removedTag: res.removed.tag };
    }
    return { ok: true, removedTag: null };
  }

  async state(
    schoolId: string,
    args: { language?: string } = {},
  ): Promise<VoiceStateView> {
    const s = await this.stateRow(schoolId);
    const lang: SpokenLanguage = args.language === "es" ? "es" : "en";
    return {
      pending:
        s.pendingTag && s.pendingSuggested && s.pendingLane
          ? {
              tag: s.pendingTag,
              suggestedTag: s.pendingSuggested,
              prompt:
                s.pendingKind === "readback"
                  ? readbackPrompt(lang, s.pendingTag, s.pendingSuggested, s.pendingLane)
                  : confirmPrompt(lang, s.pendingTag, s.pendingSuggested, s.pendingLane),
            }
          : null,
      lastTag: s.lastTag,
      lastOutcome: s.lastOutcome,
    };
  }
}
