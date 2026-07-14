/**
 * C-2 property 테스트 — audit(build(x)) 불변식 (계획서 §4 C-2 정의 그대로)
 *
 * 불변식:
 *  ⓐ 서버 소관 위반(타이밍·간격·겹침·줄 수·줄 길이·노출시간) = 0건
 *  ⓑ 텍스트 소관 위반(cps_exceeded, too_many_lines 불가피분)은 build 응답의
 *     needs_attention이 같은 큐(시각)에 대해 선언한 경우에만 허용
 *     — 선언 없는 발생 = 실패 (침묵 실패 금지)
 *
 * 결정론: 시드 고정 PRNG(mulberry32, 손구현 — 의존성 추가 금지).
 * 실행: npm run build 후 `node test/property.mjs` (N: PROPERTY_N env, 기본 2000)
 * 실패 시 시드 + 최소화한 재현 입력을 덤프한다.
 */
import { buildCues, auditCues, insertSoundEvents } from "../build/engine.js";
import { getRuleset } from "../build/standards.js";

const BASE_SEED = 20260714;
const N = Number(process.env.PROPERTY_N ?? 2000);

// ---------------------------------------------------------------- PRNG

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 입력 생성

const HANGUL = "가나다라마바사아자차카타파하기억하렴서글픈모습배포검색개선회의자막접근성";
const LATIN = "abcdefgXYZ0123456789";
const PUNCT = ".,!?…";

function genText(rng) {
  // 가중 1~64자 목표, 한글/라틴/구두점/공백 혼합 (한글 가중)
  const target = 1 + Math.floor(rng() * 64);
  let out = "";
  let w = 0;
  while (w < target) {
    const r = rng();
    let ch;
    if (r < 0.62) ch = HANGUL[Math.floor(rng() * HANGUL.length)];
    else if (r < 0.8) ch = LATIN[Math.floor(rng() * LATIN.length)];
    else if (r < 0.9) ch = PUNCT[Math.floor(rng() * PUNCT.length)];
    else ch = " ";
    out += ch;
    w += /[가-힣]/.test(ch) ? 1 : 0.5;
  }
  const trimmed = out.trim();
  return trimmed.length ? trimmed : "가";
}

function genSpeakers(rng) {
  const mode = rng();
  if (mode < 0.3) return []; // 화자 없음
  const count = 1 + Math.floor(rng() * 3);
  return Array.from({ length: count }, (_, i) => {
    const len = 1 + Math.floor(rng() * 10); // 1~10자
    let s = "";
    for (let k = 0; k < len; k++)
      s += rng() < 0.8 ? HANGUL[Math.floor(rng() * HANGUL.length)] : LATIN[Math.floor(rng() * LATIN.length)];
    return `${s}${i}`;
  });
}

function genCase(seed) {
  const rng = mulberry32(seed);
  const speakers = genSpeakers(rng);
  const segCount = 1 + Math.floor(rng() * 12);
  const segments = [];
  let t = Math.floor(rng() * 3000);
  for (let i = 0; i < segCount; i++) {
    const dur = 1 + Math.floor(rng() * 8000);
    const seg = { start_ms: t, end_ms: t + dur, text: genText(rng) };
    if (speakers.length && rng() < 0.85)
      seg.speaker = rng() < 0.5 ? speakers[i % speakers.length] : speakers[Math.floor(rng() * speakers.length)];
    if (rng() < 0.12) seg.kind = "lyrics";
    segments.push(seg);
    // 겹침·0간격·초근접·정상 간격 혼합
    const g = rng();
    let gap;
    if (g < 0.2) gap = -Math.floor(rng() * dur); // 겹침 (뒤 큐가 앞 큐 안에서 시작)
    else if (g < 0.35) gap = 0; //                   0간격
    else if (g < 0.5) gap = 1 + Math.floor(rng() * 83); // 초근접 (< min_gap)
    else gap = Math.floor(rng() * 2500);
    t = Math.max(0, t + dur + gap);
  }
  const soundEvents = [];
  const evCount = Math.floor(rng() * 3.5); // 0~3
  for (let i = 0; i < evCount; i++) {
    const len = 1 + Math.floor(rng() * 14);
    let label = "";
    for (let k = 0; k < len; k++)
      label += rng() < 0.7 ? HANGUL[Math.floor(rng() * HANGUL.length)] : LATIN[Math.floor(rng() * LATIN.length)];
    soundEvents.push({ at_ms: Math.floor(rng() * (t + 4000)), label });
  }
  const ruleset = getRuleset(
    rng() < 0.7 ? "sdh" : "standard",
    rng() < 0.8 ? "adult" : "children",
    rng() < 0.2 ? "intensive" : undefined,
  );
  return { segments, soundEvents, ruleset, speaker_labels: rng() < 0.8 };
}

// ---------------------------------------------------------------- 불변식

// ⓐ 서버 소관 규칙 — audit에서 0건이어야 함 (info 제외)
const SERVER_RULES = new Set([
  "empty_cue",
  "non_positive_duration",
  "line_too_long",
  "overlap",
  "gap_too_small",
  "duration_too_short",
  "duration_too_long",
]);
// ⓑ 텍스트 소관 — build 선언 규칙 ↔ audit 검출 규칙
const DECLARES = { needs_text_reduction: "cps_exceeded", cue_overflow: "too_many_lines" };
const TEXT_RULES = new Set(Object.values(DECLARES));

function violate(input) {
  const built = buildCues(input.segments, input.ruleset, { speaker_labels: input.speaker_labels });
  if (input.soundEvents.length) insertSoundEvents(built.cues, input.soundEvents, input.ruleset);
  const audit = auditCues(built.cues, input.ruleset);
  // 선언 대조는 시각(time) 기준 — 효과음 독립 큐 삽입으로 큐 번호가 밀릴 수 있음
  const declared = new Set(built.violations.map((v) => `${DECLARES[v.rule] ?? v.rule}@${v.time}`));
  return audit.filter(
    (v) =>
      (SERVER_RULES.has(v.rule) && v.severity !== "info") ||
      (TEXT_RULES.has(v.rule) && !declared.has(`${v.rule}@${v.time}`)),
  );
}

// ---------------------------------------------------------------- 최소화 (segments 축소 → 텍스트 반절)

function minimize(input) {
  let cur = input;
  let shrunk = true;
  while (shrunk) {
    shrunk = false;
    for (let i = 0; i < cur.segments.length && cur.segments.length > 1; i++) {
      const cand = { ...cur, segments: cur.segments.filter((_, k) => k !== i) };
      if (violate(cand).length) {
        cur = cand;
        shrunk = true;
        break;
      }
    }
    if (shrunk) continue;
    if (cur.soundEvents.length) {
      const cand = { ...cur, soundEvents: [] };
      if (violate(cand).length) {
        cur = cand;
        shrunk = true;
        continue;
      }
    }
    for (let i = 0; i < cur.segments.length; i++) {
      const s = cur.segments[i];
      if (s.text.length < 2) continue;
      for (const half of [s.text.slice(0, Math.ceil(s.text.length / 2)), s.text.slice(Math.floor(s.text.length / 2))]) {
        if (!half.trim()) continue;
        const cand = {
          ...cur,
          segments: cur.segments.map((seg, k) => (k === i ? { ...seg, text: half.trim() } : seg)),
        };
        if (violate(cand).length) {
          cur = cand;
          shrunk = true;
          break;
        }
      }
      if (shrunk) break;
    }
  }
  return cur;
}

// ---------------------------------------------------------------- 실행

let checked = 0;
for (let i = 0; i < N; i++) {
  const seed = BASE_SEED + i;
  const input = genCase(seed);
  const bad = violate(input);
  checked++;
  if (bad.length) {
    const min = minimize(input);
    console.error(`\n❌ 불변식 위반 (seed=${seed}, ${checked}번째 케이스)`);
    console.error("위반:", JSON.stringify(violate(min), null, 2));
    console.error(
      "최소 재현 입력:",
      JSON.stringify(
        { ruleset_id: min.ruleset.id, speaker_labels: min.speaker_labels, segments: min.segments, sound_events: min.soundEvents },
        null,
        2,
      ),
    );
    console.error(`재실행: PROPERTY_N=1로 genCase(${seed}) 또는 위 입력을 buildCues에 직접 전달`);
    process.exit(1);
  }
}
console.log(`✅ property 불변식 통과 — ${checked}케이스 (seed ${BASE_SEED}..${BASE_SEED + N - 1})`);
