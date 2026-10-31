// Unit tests — Fri Oct 30 integration (live adapters).
//
// Grades the pieces the stub gates cannot reach:
//   1. SAM mask codec (src/sam-mask.ts) against Meta's published vectors:
//      the protocol's 5×5 one_bit example, and a VERBATIM captured live
//      API lossless payload (Meta's conformance case
//      captured-api-image-lossless) with its published decoded raster.
//   2. The SAM response parser + centroid math against the REAL Oct 29
//      capture summary (spike-run/sam-result2.json: the spike stored the
//      parsed boxes/counts, not the raw output_text). The fixture pairs
//      those exact boxes with mask payloads produced by Meta's reference
//      encoder for known rasters, so the decoded pixel counts, centroids
//      and areas are known exactly (oracle: meta-sam-parser 0.1.0).
//      A truncated REAL payload prefix (from sam-result.json's excerpt)
//      must fail closed, never yield a partial count.
//   3. Spark adapter surface: parseSparkCompletion against the recorded
//      live completions in spike-run/spark-result*.json (valid + the
//      measured empty-content failure), request construction (schema,
//      max_tokens, non-streaming shape), the B8 walk-up scenario brief,
//      the Contributor guard, and the no-key fail-closed path.
//   4. Transcribe request builder: the multipart shape and the keywords
//      (in-play tags) the measured contract requires, built over the
//      REAL walker clip from the Oct 29 live run.
//   5. Adapter selection defaults: live + catalog model IDs by default,
//      stub on env override.
//   6. The client WAV encoder (client/src/wav.ts) behind the PTT mic:
//      header fields, mono 16-bit sample encoding, 48k→16k downsample.
//
//   bun scripts/run-unit-tests.ts

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// No live calls happen in this suite: the key is removed up front so a
// fail-closed throw can never accidentally become a network request.
const savedEnv = { ...process.env };
delete process.env.META_API_KEY;
delete process.env.COPILOT_SAM_ADAPTER;
delete process.env.COPILOT_SPARK_ADAPTER;
delete process.env.COPILOT_TRANSCRIBE_ADAPTER;
delete process.env.COPILOT_SAM_MODEL_ID;
delete process.env.COPILOT_SPARK_MODEL_ID;
delete process.env.COPILOT_TRANSCRIBE_MODEL_ID;

const { decodeMaskToRaster, parseSamSegments, decodeSegment } = await import("../src/sam-mask");
const { masksFromSamOutputText, extractSamOutputText, LiveSamAdapter, selectSamAdapter } =
  await import("../src/sam");
const {
  parseSparkCompletion, buildSparkRequest, SPARK_SCENARIO_BRIEFS, SPARK_MAX_TOKENS,
  LiveSparkAdapter, selectSparkAdapter,
} = await import("../src/spark");
const {
  buildTranscribeRequestJson, buildTranscribeForm, LiveTranscribeAdapter, selectTranscribeAdapter,
} = await import("../src/transcribe");
const { encodeWav, downsampleToRate, bytesToBase64, WAV_TARGET_SAMPLE_RATE } =
  await import("../client/src/wav");
const { areNearMatch, hammingDistanceOne, areConfusable } = await import("../src/numbers");

const SPIKE_RUN = new URL("../../../spike-run/", import.meta.url).pathname;
const readJson = (name: string) => JSON.parse(readFileSync(SPIKE_RUN + name, "utf8"));

const lines: string[] = [];
let failures = 0;
function log(s = "") {
  lines.push(s);
  console.log(s);
}
function check(label: string, cond: boolean, evidence = "") {
  log(`${cond ? "PASS" : "FAIL"}  ${label}${evidence ? ` — ${evidence}` : ""}`);
  if (!cond) failures++;
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

// ------------------------------------------------------------ SAM codec ---
log("== SAM codec — published vectors ==");
{
  // Protocol doc example: one_bit 5×5.
  const raster = decodeMaskToRaster("!!!!!(QO(0lu8?", 5, 5);
  const expected = [
    1, 0, 0, 1, 0,
    0, 0, 1, 1, 0,
    0, 0, 0, 0, 0,
    1, 0, 1, 1, 1,
    1, 0, 0, 0, 1,
  ];
  check(
    "one_bit 5x5 protocol example decodes exactly",
    JSON.stringify([...raster]) === JSON.stringify(expected),
    `ones=${raster.reduce((a, b) => a + b, 0)}`,
  );
}
{
  // Verbatim captured live API response (lossless), Meta conformance case.
  const text =
    "<0f>0<|box;x1=513;y1=371;x2=523;y2=381;w=1440;h=900|>" +
    "<|mask;x=0;y=0;data=11,11,~!!!!r!kCq#$.pF[_cZIw.?wO3R8-&NJofiCI$_J0aA.1VC*YyK_'z*(LEG8!+H9evY.82Z-4.@C[.9C@T86o$3E=-&8w3W=]xS.|>\n";
  const segments = parseSamSegments(text);
  check("captured lossless: one segment parsed", segments.length === 1, `n=${segments.length}`);
  const seg = segments[0];
  check(
    "captured lossless: box + mask dims",
    seg.box.x1 === 513 && seg.box.y1 === 371 && seg.box.x2 === 523 && seg.box.y2 === 381 &&
      seg.box.w === 1440 && seg.box.h === 900 && seg.maskWidth === 11 && seg.maskHeight === 11,
    JSON.stringify(seg.box),
  );
  const runs: Array<[number, number]> = [
    [0, 4], [1, 2], [0, 7], [1, 7], [0, 3], [1, 9], [0, 2], [1, 9], [0, 1], [1, 22],
    [0, 1], [1, 10], [0, 1], [1, 10], [0, 1], [1, 9], [0, 3], [1, 8], [0, 5], [1, 3], [0, 4],
  ];
  const expected: number[] = [];
  for (const [v, n] of runs) for (let i = 0; i < n; i++) expected.push(v);
  const raster = decodeMaskToRaster(seg.payload, seg.maskWidth, seg.maskHeight);
  check(
    "captured lossless: raster matches the published decode (121 px)",
    JSON.stringify([...raster]) === JSON.stringify(expected),
    `ones=${raster.reduce((a, b) => a + b, 0)}`,
  );
  const obj = decodeSegment(seg);
  check(
    "captured lossless: centroid math (89 px, box-offset)",
    obj !== null && obj.pixelCount === 89 &&
      near(obj.centroidPx.x, 518.1460674157304, 1e-9) && near(obj.centroidPx.y, 376.1123595505618, 1e-9),
    obj ? `centroid=(${obj.centroidPx.x}, ${obj.centroidPx.y})` : "null",
  );
}

// ------------------------------------------- SAM parser vs the real run ---
log("\n== SAM parser — spike-run/sam-result2.json (real boxes, GT 3 cars) ==");
{
  const summary = readJson("sam-result2.json");
  // Reference-encoder payloads for known rasters at the capture's exact
  // boxes (oracle stats computed with meta-sam-parser; see header).
  const oracle = [
    { payload: "!!!!!2&O9s@NAKNyWrB]H!!!!", ones: 16036, cx: 0.7359375, cy: 0.5029850746268657, area: 0.07479477611940298 },
    { payload: "!!!!!b=pO?OWMQ)U&e[r.Rm7h!-m]fPfoO%astVM?!.xWrmxVbaB2b.'tC8)h&$[`KAUpqE=O4WQ!!!!", ones: 2997, cx: 0.796875, cy: 0.39104477611940297, area: 0.013978544776119402 },
    { payload: "!!!!!5)_RC8SdqQy*'he6g$XIK!!!", ones: 12326, cx: 0.5105782492292714, cy: 0.5640354934721169, area: 0.057490671641791044 },
  ];
  const records = summary.boxes
    .map((b: any, i: number) => {
      const w = b.x2 - b.x1 + 1;
      const h = b.y2 - b.y1 + 1;
      return `${i}<|box;x1=${b.x1};y1=${b.y1};x2=${b.x2};y2=${b.y2};w=${b.w};h=${b.h}|>` +
        `<|mask;x=0;y=0;data=${h},${w},${oracle[i].payload}|>`;
    })
    .join(",");
  const outputText = `<0f>${records}`;
  const responseJson = {
    model: "sam-3.1",
    status: "completed",
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: outputText }] },
    ],
  };
  const extracted = extractSamOutputText(responseJson);
  check("response JSON: output_text lane extracted", extracted === outputText);
  const segments = parseSamSegments(extracted!);
  check(
    "parser yields exactly 3 boxes + 3 masks (ground truth 3/3)",
    segments.length === 3 && summary.boxCount === 3 && summary.maskCount === 3,
    `segments=${segments.length}, file boxCount=${summary.boxCount}, maskCount=${summary.maskCount}`,
  );
  const boxesMatch = segments.every((s, i) => {
    const b = summary.boxes[i];
    return s.box.x1 === b.x1 && s.box.y1 === b.y1 && s.box.x2 === b.x2 && s.box.y2 === b.y2 &&
      s.box.w === b.w && s.box.h === b.h &&
      s.maskWidth === b.x2 - b.x1 + 1 && s.maskHeight === b.y2 - b.y1 + 1;
  });
  check("parsed boxes deep-equal the capture's boxes", boxesMatch);
  const masks = masksFromSamOutputText(extracted!, "car");
  check("adapter mapping yields 3 masks", masks.length === 3, `n=${masks.length}`);
  masks.forEach((m, i) => {
    const o = oracle[i];
    check(
      `mask ${i}: centroid + area match the reference decode`,
      m.label === "car" && near(m.centroid.x, o.cx) && near(m.centroid.y, o.cy) && near(m.area, o.area),
      `centroid=(${m.centroid.x}, ${m.centroid.y}) area=${m.area} ones=${o.ones}`,
    );
  });

  // Fail closed on a truncated REAL payload: sam-result.json's excerpt
  // carries the genuine first-mask prefix of the oversized-still run —
  // its length prefix declares ~6.7 KB of body the excerpt does not
  // contain. Decoding must throw; a partial count must never emerge.
  const excerpt: string = readJson("sam-result.json").excerpt;
  const marker = "data=114,273,";
  const at = excerpt.indexOf(marker);
  check("sam-result.json excerpt carries a real mask prefix", at >= 0);
  const truncatedPayload = excerpt.slice(at + marker.length, at + marker.length + 300).replaceAll("\\", "");
  const truncatedText =
    `<0f>0<|box;x1=336;y1=111;x2=608;y2=224;w=640;h=335|>` +
    `<|mask;x=0;y=0;data=114,273,${truncatedPayload}|>`;
  let threw = false;
  try {
    masksFromSamOutputText(truncatedText, "car");
  } catch {
    threw = true;
  }
  check("truncated real payload fails closed (throws, no partial count)", threw);
}

// ------------------------------------------------------------- Spark ---
log("\n== Spark adapter — recorded live completions + request shape ==");
{
  const valid = readJson("spark-result2.json");
  const completion = {
    choices: [
      { finish_reason: "stop", message: { role: "assistant", content: valid.rawContent } },
    ],
  };
  const line = parseSparkCompletion(completion);
  check(
    "recorded valid completion parses to its line",
    line !== null && line.action === "check_tag" && line.instruction === valid.parsed.instruction,
    line ? JSON.stringify(line) : "null",
  );

  const empty = readJson("spark-result.json");
  check(
    "recorded empty-content completion (streaming failure) → null (fallback trigger)",
    empty.rawContent === "" && parseSparkCompletion({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: empty.rawContent } }],
    }) === null,
  );
  check(
    "null content → null",
    parseSparkCompletion({ choices: [{ message: { content: null } }] }) === null,
  );
  check(
    "action outside the product enum (release_wave) → null",
    parseSparkCompletion({
      choices: [{ message: { content: JSON.stringify({ instruction: "Release the wave now.", action: "release_wave", confidence: 0.9 }) } }],
    }) === null,
  );
  check(
    "missing confidence → null; over-length instruction → null",
    parseSparkCompletion({
      choices: [{ message: { content: JSON.stringify({ instruction: "Check the tag.", action: "check_tag" }) } }],
    }) === null &&
      parseSparkCompletion({
        choices: [{ message: { content: JSON.stringify({ instruction: "x".repeat(141) + ".", action: "info", confidence: 0.5 }) } }],
      }) === null,
  );

  const payload: any = {
    trigger: "walk_up",
    school_mode: "dual",
    entries: [{ tag: "132", lane: "left", wave: "L2", status: "entered" }],
    zone: { lane: "left", count: 4, expected: 4, consecutive_mismatches: 0 },
    detail: { walk_up_tag: "132" },
  };
  const req = buildSparkRequest("muse-spark-1.3", payload);
  check(
    "request: non-streaming shape, minimal effort, max_tokens >= 1000 (starvation fix)",
    req.model === "muse-spark-1.3" && req.reasoning_effort === "minimal" &&
      req.max_tokens === SPARK_MAX_TOKENS && SPARK_MAX_TOKENS >= 1000 &&
      !("stream" in req),
    `max_tokens=${req.max_tokens}`,
  );
  const schema = (req.response_format as any).json_schema;
  check(
    "request: strict json_schema with the PRODUCT action enum",
    req.response_format.type === "json_schema" && schema.strict === true &&
      JSON.stringify(schema.schema.properties.action.enum) ===
        JSON.stringify(["hold_wave", "check_tag", "keep_out_of_wave", "sweep", "info"]) &&
      schema.schema.properties.instruction.maxLength === 140,
  );
  const userContent = JSON.parse((req.messages[1] as any).content);
  check(
    "request: user content carries scenario brief + untouched board_state",
    userContent.scenario === SPARK_SCENARIO_BRIEFS.walk_up &&
      JSON.stringify(userContent.board_state) === JSON.stringify(payload),
  );
  check(
    "B8 fix: walk_up brief states a walk-up does not change the vehicle count and a verified wave is NOT held",
    /does NOT change the number of vehicles expected/.test(SPARK_SCENARIO_BRIEFS.walk_up) &&
      /must NOT be held/.test(SPARK_SCENARIO_BRIEFS.walk_up),
  );

  // Fail-closed paths (no network: the key is deleted for this suite).
  let noKeyThrew = "";
  try {
    await new LiveSparkAdapter().advise(payload);
  } catch (e) {
    noKeyThrew = e instanceof Error ? e.message : String(e);
  }
  check("no key → live_adapter_error (service falls back)", noKeyThrew.startsWith("live_adapter_error"), noKeyThrew.slice(0, 60));

  process.env.COPILOT_SPARK_MODEL_ID = "muse-spark-1.3-contributor";
  let contributorThrew = "";
  try {
    await new LiveSparkAdapter().advise(payload);
  } catch (e) {
    contributorThrew = e instanceof Error ? e.message : String(e);
  }
  delete process.env.COPILOT_SPARK_MODEL_ID;
  check(
    "Contributor model ID refused before any call",
    contributorThrew.startsWith("contributor_model_forbidden"),
    contributorThrew.slice(0, 60),
  );
}

// --------------------------------------------------------- Transcribe ---
log("\n== Transcribe adapter — multipart builder over the real walker clip ==");
{
  const wav = readFileSync(SPIKE_RUN + "walker-clip.wav");
  const input = { lane: "left", biasedTags: ["345", "101", "102", "103", "104", "354"], language: "en" };
  const requestJson = buildTranscribeRequestJson("muse-voice-transcribe-1.0", input);
  check(
    "request JSON = the measured contract (PUSH_TO_TALK / WAV / keywords = in-play tags)",
    requestJson.mode === "PUSH_TO_TALK" && requestJson.model === "muse-voice-transcribe-1.0" &&
      requestJson.audioEncoding === "WAV" &&
      JSON.stringify(requestJson.keywords) === JSON.stringify(input.biasedTags) &&
      !("languageBias" in requestJson),
    JSON.stringify(requestJson),
  );
  check(
    "empty closed set → keywords omitted (no empty bias)",
    !("keywords" in buildTranscribeRequestJson("muse-voice-transcribe-1.0", { lane: "left", biasedTags: [] })),
  );
  const form = buildTranscribeForm("muse-voice-transcribe-1.0", input, wav);
  const requestPart = form.get("request") as Blob;
  const audioPart = form.get("audio") as File;
  const parsedRequest = JSON.parse(await requestPart.text());
  check(
    "multipart: JSON part named 'request' (application/json) with the keywords",
    // Bun appends ";charset=utf-8" to the part's type locally; the
    // deployed Lambda runtime sends exactly "application/json" (the
    // measured spike's construction). Either is the same JSON part.
    requestPart.type.startsWith("application/json") &&
      JSON.stringify(parsedRequest) === JSON.stringify(requestJson),
  );
  check(
    "multipart: WAV part named 'audio' carries the clip bytes unchanged",
    audioPart.type === "audio/wav" && audioPart.size === wav.length && audioPart.name === "walker.wav",
    `size=${audioPart.size} vs clip=${wav.length}`,
  );

  let noKeyThrew = "";
  try {
    await new LiveTranscribeAdapter().transcribe({
      lane: "left",
      biasedTags: input.biasedTags,
      audioBase64: wav.toString("base64"),
    });
  } catch (e) {
    noKeyThrew = e instanceof Error ? e.message : String(e);
  }
  check("no key → live_adapter_error (service asks for a repeat)", noKeyThrew.startsWith("live_adapter_error"), noKeyThrew.slice(0, 60));
}

// ------------------------------------------- WAV encoder (client) ---
log("\n== WAV encoder — client/src/wav.ts (PTT mic capture) ==");
{
  const ascii = (b: Uint8Array, from: number, to: number) =>
    String.fromCharCode(...b.subarray(from, to));

  // Downsample: box averages, exact counts; never upsamples.
  const nine = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const third = downsampleToRate(nine, 48000, 16000);
  check(
    "downsample 48k→16k: count + box averages",
    third.length === 3 && third[0] === 1 && third[1] === 4 && third[2] === 7,
    `n=${third.length} values=${[...third]}`,
  );
  const sameRate = downsampleToRate(nine, 16000, 16000);
  check(
    "downsample at target rate: untouched copy",
    sameRate.length === 9 && sameRate !== nine && sameRate[8] === 8,
  );

  // Header + sample encoding at the target rate (no resampling).
  const samples = new Float32Array([0, 1, -1, 0.5, 2]); // 2 exercises the clamp
  const wav = encodeWav(samples, WAV_TARGET_SAMPLE_RATE);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  check(
    "wav: RIFF/WAVE/fmt/data structure",
    ascii(wav, 0, 4) === "RIFF" && ascii(wav, 8, 12) === "WAVE" &&
      ascii(wav, 12, 16) === "fmt " && ascii(wav, 36, 40) === "data" &&
      view.getUint32(4, true) === 36 + samples.length * 2 &&
      view.getUint32(16, true) === 16 && view.getUint32(40, true) === samples.length * 2 &&
      wav.length === 44 + samples.length * 2,
    `bytes=${wav.length}`,
  );
  check(
    "wav: PCM format fields — mono, 16-bit, 16 kHz",
    view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1 &&
      view.getUint32(24, true) === 16000 && view.getUint32(28, true) === 32000 &&
      view.getUint16(32, true) === 2 && view.getUint16(34, true) === 16,
  );
  check(
    "wav: sample values encode exactly (incl. clamp at full scale)",
    view.getInt16(44, true) === 0 && view.getInt16(46, true) === 32767 &&
      view.getInt16(48, true) === -32768 && view.getInt16(50, true) === 16383 &&
      view.getInt16(52, true) === 32767,
  );

  // Resampling encode: 4800 samples @48k → 1600 @16k under a 16 kHz header.
  const big = encodeWav(new Float32Array(4800).fill(0.25), 48000);
  const bigView = new DataView(big.buffer, big.byteOffset, big.byteLength);
  check(
    "wav: 48k input downsamples to 1600 samples under a 16 kHz header",
    big.length === 44 + 1600 * 2 && bigView.getUint32(24, true) === 16000 &&
      bigView.getUint32(40, true) === 1600 * 2,
    `bytes=${big.length}`,
  );

  // Base64 transport round-trips byte-exactly.
  check(
    "wav: bytesToBase64 round-trips",
    Buffer.from(bytesToBase64(wav), "base64").equals(Buffer.from(wav)),
  );
}

// --------------------------------- CONFIRM guard shapes (numbers) ---
log("\n== Numbers — the widened CONFIRM guard's two confusion shapes ==");
{
  check(
    "transposition twins are near matches (345/354, 212/221) — and two digits off by Hamming",
    areNearMatch("345", "354") && areNearMatch("212", "221") &&
      !hammingDistanceOne("345", "354") && !hammingDistanceOne("212", "221"),
  );
  check(
    "one digit off is Hamming-1 and NOT a transposition (101/102, 212/214)",
    hammingDistanceOne("101", "102") && hammingDistanceOne("212", "214") &&
      !areNearMatch("101", "102") && !areNearMatch("212", "214"),
  );
  check(
    "confusable = transposition OR one digit off (both shapes covered)",
    areConfusable("345", "354") && areConfusable("101", "102") && areConfusable("212", "214"),
  );
  check(
    "unrelated tags, identical tags, and different lengths are never confusable",
    !areConfusable("101", "345") && !areConfusable("101", "101") &&
      !hammingDistanceOne("101", "101") && !hammingDistanceOne("101", "1011") &&
      !areNearMatch("101", "1011"),
  );
}

// ------------------------------------------------- SAM fail-closed ---
log("\n== SAM adapter — fail-closed without a key ==");
{
  let threw = "";
  try {
    await new LiveSamAdapter().countVehicles({ lane: "left", prompt: "car", imageBase64: "AAAA" });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check("no key → live_adapter_error, no count produced", threw.startsWith("live_adapter_error"), threw.slice(0, 60));
}

// ------------------------------------------------------ selection ---
log("\n== Adapter selection — live defaults, stub override ==");
{
  check(
    "defaults: live adapters with the exact catalog model IDs",
    selectSamAdapter().kind === "live" && selectSamAdapter().modelId === "sam-3.1" &&
      selectSparkAdapter().kind === "live" && selectSparkAdapter().modelId === "muse-spark-1.3" &&
      selectTranscribeAdapter().kind === "live" &&
      selectTranscribeAdapter().modelId === "muse-voice-transcribe-1.0",
    `sam=${selectSamAdapter().modelId} spark=${selectSparkAdapter().modelId} transcribe=${selectTranscribeAdapter().modelId}`,
  );
  process.env.COPILOT_SAM_ADAPTER = "stub";
  process.env.COPILOT_SPARK_ADAPTER = "stub";
  process.env.COPILOT_TRANSCRIBE_ADAPTER = "stub";
  check(
    "env override: stub adapters (the gate harnesses' mode)",
    selectSamAdapter().kind === "stub" && selectSparkAdapter().kind === "stub" &&
      selectTranscribeAdapter().kind === "stub",
  );
  delete process.env.COPILOT_SAM_ADAPTER;
  delete process.env.COPILOT_SPARK_ADAPTER;
  delete process.env.COPILOT_TRANSCRIBE_ADAPTER;
}

Object.assign(process.env, savedEnv);
log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} — unit tests (live adapters)`);
mkdirSync(new URL("../test-results/", import.meta.url).pathname, { recursive: true });
writeFileSync(
  new URL("../test-results/unit-tests-2026-10-30.txt", import.meta.url).pathname,
  lines.join("\n") + "\n",
);
process.exit(failures ? 1 : 0);
