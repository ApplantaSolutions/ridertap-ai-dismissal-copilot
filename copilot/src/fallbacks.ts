// Rule-fallback lines — the deterministic answer when Spark is slow,
// down, malformed, or guard-rejected (test-assets/EXCEPTION-SCRIPTS.md).
//
// These strings are VERBATIM from the scripts file. Only the tag / count
// / wave values are templated, exactly where the scripts template them.
// Do not "improve" the wording: the timeout drill grades these lines
// word-for-word, and a dismissal lead under time pressure gets the same
// sentence every time — that sameness is the feature.
//
// There is no third outcome in the exception contract: the lead always
// gets exactly one line — Spark's (validated) or this one.

import type { BoardStateSummary, ExceptionLine } from "./exceptions";

function laneName(lane: string): string {
  return lane === "main" ? "Main" : lane.charAt(0).toUpperCase() + lane.slice(1);
}

export function ruleFallback(p: BoardStateSummary): ExceptionLine {
  switch (p.trigger) {
    case "zone_mismatch": {
      const zone = p.zone!;
      const waveId = p.wave?.id ?? "";
      // EX-01 (count above expected): the extra-car line.
      if (zone.count > zone.expected) {
        return {
          instruction:
            `Zone count is ${zone.count}, wave ${waveId} expects ${zone.expected} — ` +
            "hold the wave and check the extra car.",
          action: "hold_wave",
        };
      }
      // EX-02 (count below expected): the missing-car line.
      return {
        instruction:
          `Zone count is ${zone.count}, wave ${waveId} expects ${zone.expected} — ` +
          "check for the missing car before loading.",
        action: "check_tag",
      };
    }
    case "out_of_order": {
      // EX-03.
      const arrived = String(p.detail?.arrived_tag ?? "");
      const skipped = String(p.detail?.skipped_tag ?? "");
      return {
        instruction:
          `${arrived} arrived ahead of ${skipped} — load in board order and watch for ${skipped} next.`,
        action: "info",
      };
    }
    case "duplicate": {
      // EX-04.
      const tag = String(p.detail?.attempted_tag ?? p.entries?.[0]?.tag ?? "");
      const lane = String(p.detail?.attempted_lane ?? p.entries?.[0]?.lane ?? "");
      return {
        instruction: `${tag} is already on the board in ${laneName(lane)} — do not re-enter it.`,
        action: "info",
      };
    }
    case "hold_placed": {
      const tag = p.holds?.[0] ?? p.entries?.[0]?.tag ?? "";
      // EX-06 (wave actively loading): the mid-load variant.
      if (p.wave?.status === "loading") {
        return {
          instruction:
            `${tag} is on hold — stop it here; the rest of Wave ${p.wave.id} continues.`,
          action: "keep_out_of_wave",
        };
      }
      // EX-05 (wave not yet loading).
      return {
        instruction: `${tag} is on hold — do not load it until the office clears it.`,
        action: "keep_out_of_wave",
      };
    }
    case "walk_up": {
      // EX-07.
      const tag = String(p.detail?.walk_up_tag ?? p.entries?.[0]?.tag ?? "");
      return {
        instruction: `${tag} arrived on foot — handle at the pickup point, not in a car wave.`,
        action: "keep_out_of_wave",
      };
    }
    case "no_show_candidate": {
      // EX-08.
      const tags = (p.detail?.still_waiting_tags as string[] | undefined) ?? [];
      const tag = tags[0] ?? p.entries?.[0]?.tag ?? "";
      return {
        instruction:
          `${tag} is still waiting and never arrived — contact the guardian before marking no-show.`,
        action: "sweep",
      };
    }
    default:
      throw new Error(`rule_fallback_unknown_trigger: ${String((p as { trigger: unknown }).trigger)}`);
  }
}
