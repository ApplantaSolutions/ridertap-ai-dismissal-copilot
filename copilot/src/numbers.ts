// Transcript normalization — spoken numbers (EN + ES) → tag digits.
//
// The resolver's first stage (contract: test-assets/VOICE-CASES.md):
// a transcript becomes a candidate tag ONLY if it parses, completely,
// as one 3-digit number. Both speaking styles must normalize to the
// same digits:
//   grouped        "three forty-five"  → 345      "two fourteen" → 214
//   digit-by-digit "three five four"   → 354      "four oh one"  → 401
// Spanish full forms parse identically ("trescientos cuarenta y cinco"
// → 345 vs "trescientos cincuenta y cuatro" → 354 — the pair differs
// only in the last phrase and both must land exactly).
//
// Partials and fragments ("3 4", "22", "two twen") parse to NOTHING —
// null, never padded, never auto-completed. The resolver turns null
// into ASK-REPEAT.
//
// Lane callouts ("left 214") are routing, never digits. Filler words
// are stripped. ASR homophones are corrected where the case file
// defines them: "for"/"fore" heard for "four" ("tag for 01" → 401 —
// the "for" IS the four the walker said; dropping it would invent a
// 2-digit fragment and break VC-08, and treating it as an extra token
// would invent phantom tags).
//
// A single leading "walker" is the staff role call-sign, never a
// number word: the Fri Oct 30 100× battery showed the live model
// returning "Walker 345." verbatim (3/3 on that clip), and a walker
// announcing their role must not ASK-REPEAT. It is stripped at the
// lead ONLY — deliberately not a general filler, so an unknown token
// anywhere else still fails the parse closed (battery Fix 2).

export type SpokenLanguage = "en" | "es";

export interface NormalizedTranscript {
  /** The 3-digit tag, or null when the transcript resolves to nothing. */
  tag: string | null;
  /** The parsed digit string before the 3-digit gate (diagnostics only). */
  digits: string | null;
  /** Lane named in the utterance, if any ('left' | 'right' | 'main'). */
  lane: string | null;
  /** Language detected in THIS utterance (never session state). */
  language: SpokenLanguage;
}

function fold(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/-/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LANE_WORDS: Record<string, string> = {
  left: "left",
  right: "right",
  main: "main",
  izquierda: "left",
  derecha: "right",
};
const FILLERS = new Set(["tag", "the", "a", "an", "please", "uh", "um", "car", "line"]);

// ------------------------------------------------------------- English ---
const EN_UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9,
  oh: 0, // "four oh one"
  for: 4, fore: 4, // ASR homophones of "four" (VC-08)
};
const EN_TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

// ------------------------------------------------------------- Spanish ---
const ES_UNITS: Record<string, number> = {
  cero: 0, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9,
};
const ES_TEENS: Record<string, number> = {
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veintiuno: 21, veintiun: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27,
  veintiocho: 28, veintinueve: 29,
};
const ES_TENS: Record<string, number> = {
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60,
  setenta: 70, ochenta: 80, noventa: 90,
};
const ES_HUNDREDS: Record<string, number> = {
  cien: 100, ciento: 100, doscientos: 200, trescientos: 300,
  cuatrocientos: 400, quinientos: 500, seiscientos: 600, setecientos: 700,
  ochocientos: 800, novecientos: 900,
};
const ES_MARKERS = new Set([
  ...Object.keys(ES_UNITS), ...Object.keys(ES_TEENS), ...Object.keys(ES_TENS),
  ...Object.keys(ES_HUNDREDS), "izquierda", "derecha",
]);

type Place = "unit" | "teen" | "tens" | "hundred";
interface Atom {
  place: Place;
  value: number;
}

/** Expand one token into atoms; null when the token is not a number token. */
function atomize(
  token: string,
  units: Record<string, number>,
  teens: Record<string, number>,
  tens: Record<string, number>,
  hundreds: Record<string, number> | null,
): Atom[] | null {
  if (/^\d+$/.test(token)) {
    return token.split("").map((d) => ({ place: "unit" as Place, value: Number(d) }));
  }
  if (token in units) return [{ place: "unit", value: units[token] }];
  if (token in teens) return [{ place: "teen", value: teens[token] }];
  if (token in tens) return [{ place: "tens", value: tens[token] }];
  if (hundreds && token in hundreds) return [{ place: "hundred", value: hundreds[token] }];
  if (token === "hundred") return [{ place: "hundred", value: 100 }];
  return null;
}

function allUnits(atoms: Atom[]): string | null {
  if (atoms.length && atoms.every((a) => a.place === "unit")) {
    return atoms.map((a) => String(a.value)).join("");
  }
  return null;
}

/** English grouped grammar: [unit "hundred"] tail | unit + (tens|teen) tail. */
function parseEnglish(atoms: Atom[]): string | null {
  const joined = allUnits(atoms);
  if (joined !== null) return joined;
  let i = 0;
  let total = 0;
  if (atoms[0]?.place === "unit" && atoms[1]?.place === "hundred") {
    total += atoms[0].value * 100;
    i = 2;
  } else if (
    atoms[0]?.place === "unit" &&
    (atoms[1]?.place === "tens" || atoms[1]?.place === "teen")
  ) {
    // Grouped style without the word "hundred": "nine ninety-nine".
    total += atoms[0].value * 100;
    i = 1;
  } else if (atoms[0]?.place === "hundred") {
    total += 100;
    i = 1;
  }
  if (atoms[i]?.place === "tens") {
    total += atoms[i].value;
    i++;
    if (atoms[i]?.place === "unit") {
      total += atoms[i].value;
      i++;
    }
  } else if (atoms[i]?.place === "teen") {
    total += atoms[i].value;
    i++;
  } else if (atoms[i]?.place === "unit" && i > 0) {
    total += atoms[i].value;
    i++;
  }
  if (i !== atoms.length || i === 0) return null;
  return String(total);
}

/** Spanish grammar: strictly descending places, summed ("y" already dropped). */
function parseSpanish(atoms: Atom[]): string | null {
  const joined = allUnits(atoms);
  if (joined !== null) return joined;
  const rank: Record<Place, number> = { hundred: 3, tens: 2, teen: 2, unit: 1 };
  let last = Infinity;
  let total = 0;
  for (const a of atoms) {
    if (rank[a.place] >= last) return null;
    last = rank[a.place];
    total += a.value;
  }
  return atoms.length ? String(total) : null;
}

export function detectLanguage(tokens: string[], hint: SpokenLanguage): SpokenLanguage {
  if (tokens.some((t) => ES_MARKERS.has(t))) return "es";
  if (
    tokens.some(
      (t) =>
        t in EN_UNITS || t in EN_TEENS || t in EN_TENS || t === "hundred" ||
        t === "left" || t === "right",
    )
  ) {
    return "en";
  }
  return hint;
}

export function normalizeTranscript(
  raw: string,
  hint: SpokenLanguage = "en",
): NormalizedTranscript {
  const tokens0 = fold(raw).split(" ").filter(Boolean);
  let lane: string | null = null;
  const tokens: string[] = [];
  for (const [idx, t] of tokens0.entries()) {
    if (idx === 0 && t === "walker") continue; // role call-sign (Fix 2)
    if (idx === 0 && t in LANE_WORDS) {
      lane = LANE_WORDS[t];
      continue;
    }
    if (FILLERS.has(t)) continue;
    tokens.push(t);
  }
  const language = detectLanguage(tokens, hint);
  let digits: string | null = null;
  if (tokens.length) {
    const atoms: Atom[] = [];
    let ok = true;
    for (const t of tokens) {
      if (language === "es" && t === "y") continue; // connector, not a digit
      const a =
        language === "es"
          ? atomize(t, ES_UNITS, ES_TEENS, ES_TENS, ES_HUNDREDS)
          : atomize(t, EN_UNITS, EN_TEENS, EN_TENS, null);
      if (!a) {
        ok = false;
        break;
      }
      atoms.push(...a);
    }
    if (ok && atoms.length) {
      digits = language === "es" ? parseSpanish(atoms) : parseEnglish(atoms);
    }
  }
  return {
    tag: digits !== null && digits.length === 3 ? digits : null,
    digits,
    lane,
    language,
  };
}

/**
 * Near-match for the CONFIRM rule: the confusion pairs (345/354, 212/221)
 * are exact digit transpositions — the same digits in a different order.
 */
export function areNearMatch(a: string, b: string): boolean {
  if (a === b || a.length !== b.length) return false;
  const sort = (s: string) => s.split("").sort().join("");
  return sort(a) === sort(b);
}

/**
 * One digit off (Hamming distance exactly 1): same length, exactly one
 * digit different — 101 vs 102. The Oct 30 hostile-voice battery's one
 * true wrong entry was this shape: a hurried "one zero one" came back
 * from the ASR as the in-wave decoy 102 — a substitution, not a
 * transposition, so the twin guard never saw it.
 */
export function hammingDistanceOne(a: string, b: string): boolean {
  if (a === b || a.length !== b.length) return false;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && ++diffs > 1) return false;
  }
  return diffs === 1;
}

/**
 * The widened read-back CONFIRM guard (JR-approved, Oct 30): a live tag
 * is confusable with the heard tag when it is a digit transposition OR
 * one digit off — both shapes are a single mishear away from the heard
 * tag, so neither may enter silently while the other is live.
 */
export function areConfusable(a: string, b: string): boolean {
  return areNearMatch(a, b) || hammingDistanceOne(a, b);
}
