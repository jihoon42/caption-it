/**
 * C-1 회귀 테스트 — 장식(라벨/♪/효과음)을 산술 앞으로 (계획서 §4 C-1)
 *
 * 문제(P0-1): buildCues가 CPS 검사 → 라벨 → ♪ → 줄바꿈 순서라 라벨·♪ 가중치가
 * 미검증이었고, overflow 분할이 라벨 경계에서 쪼개져 [화자]만 담긴 유령 큐가 생겼다.
 * insertSoundEvents의 이중 표기 부착·독립 큐 폭도 재검증이 없었다.
 *
 * 원칙: build는 스스로 위반을 선언하거나 위반 없는 산출물을 내야 한다 (침묵 실패 금지).
 * 실행: npm run build 후 `node test/regression-c1.mjs`
 */
import { buildCues, auditCues, insertSoundEvents } from "../build/engine.js";
import { getRuleset } from "../build/standards.js";

const rs = getRuleset("sdh", "adult");
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok: ${name}`);
  else {
    failed++;
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// 서버 소관 규칙(불변식 ⓐ) — 텍스트 소관(cps_exceeded·too_many_lines)과 구분
const SERVER_RULES = [
  "empty_cue",
  "non_positive_duration",
  "line_too_long",
  "overlap",
  "gap_too_small",
  "duration_too_long",
];
// build가 선언하는 규칙 ↔ audit이 검출하는 규칙 대응 (불변식 ⓑ)
const DECLARES = { needs_text_reduction: "cps_exceeded", cue_overflow: "too_many_lines" };

const undeclaredTextViolations = (audit, built) =>
  audit.filter(
    (v) =>
      (v.rule === "cps_exceeded" || v.rule === "too_many_lines") &&
      !built.violations.some((b) => DECLARES[b.rule] === v.rule && b.cue_index === v.cue_index),
  );
const serverViolations = (audit) =>
  audit.filter((v) => SERVER_RULES.includes(v.rule) && v.severity !== "info");

console.log("case 1: 계획서 재현 — 라벨 가중치 미검증 + 유령 큐 (P0-1)");
{
  const segs = [
    { start_ms: 0, end_ms: 2000, text: "가나다라마바사아자차카타파하가나다라마바사아자차카", speaker: "김PD" },
  ];
  const built = buildCues(segs, rs, { speaker_labels: true });
  const ghost = built.cues.filter((c) => /^\s*\[[^\]]*\]\s*$/.test(c.lines.join(" ")));
  check("라벨만 남는 유령 큐 없음", ghost.length === 0, JSON.stringify(ghost));
  const audit = auditCues(built.cues, rs);
  check("서버 소관 위반 0건", serverViolations(audit).length === 0, JSON.stringify(serverViolations(audit)));
  check(
    "미선언 텍스트 소관 위반 없음 (침묵 실패 금지)",
    undeclaredTextViolations(audit, built).length === 0,
    JSON.stringify(undeclaredTextViolations(audit, built)),
  );
}

console.log("case 2: overflow 분할 시 라벨은 첫 조각의 대사에");
{
  const segs = [
    { start_ms: 0, end_ms: 4000, text: "가나다라마바사아자차카타파하 나나다라마바사아자차카타파하", speaker: "진행자" },
  ];
  const built = buildCues(segs, rs, { speaker_labels: true });
  check("큐가 2개로 분할됨", built.cues.length === 2, `${built.cues.length}개`);
  check(
    "첫 조각에 라벨+대사 동반",
    /^\[진행자\] ./.test(built.cues[0]?.lines.join(" ") ?? ""),
    JSON.stringify(built.cues[0]?.lines),
  );
  check(
    "뒤 조각에는 라벨 없음",
    !(built.cues[1]?.lines.join(" ") ?? "").includes("["),
    JSON.stringify(built.cues[1]?.lines),
  );
  const audit = auditCues(built.cues, rs);
  check("서버 소관 위반 0건", serverViolations(audit).length === 0, JSON.stringify(serverViolations(audit)));
}

console.log("case 3: 효과음 이중 표기 부착 전 CPS 재검증 (II.5)");
{
  // 화자 교대(병합 방지) + 틈 없는 연속 발화 → 독립 큐 슬롯 없음 → 이중 표기 경로 강제
  const long = "가나다라마바사아자차카타파하가"; // 15자
  const segs = [0, 1200, 2400, 3600, 4800].map((t, i) => ({
    start_ms: t,
    end_ms: t + 1100,
    text: long,
    speaker: i % 2 === 0 ? "갑" : "을",
  }));
  const built = buildCues(segs, rs, { speaker_labels: false });
  const res = insertSoundEvents(built.cues, [{ at_ms: 600, label: "효과음소리큼" }], rs);
  check(
    "CPS를 초과하는 부착은 거부되고 unplaced로 보고",
    res.placed === 0 && res.unplaced.length === 1,
    `placed=${res.placed}, unplaced=${res.unplaced.length}`,
  );
  const audit = auditCues(built.cues, rs);
  check(
    "부착 결과에 cps_exceeded 없음",
    !audit.some((v) => v.rule === "cps_exceeded"),
    JSON.stringify(audit.filter((v) => v.rule === "cps_exceeded")),
  );
}

console.log("case 4: 효과음 독립 큐는 최소 노출 시간을 지킨다");
{
  const segs = [
    { start_ms: 0, end_ms: 1000, text: "가나다라마바사아자차카타파", speaker: "갑" },
    { start_ms: 1900, end_ms: 3000, text: "나다라마바사아자차카타파하", speaker: "을" },
  ];
  const built = buildCues(segs, rs, { speaker_labels: false });
  insertSoundEvents(built.cues, [{ at_ms: 1300, label: "박수" }], rs);
  const short = built.cues.filter((c) => c.end_ms - c.start_ms < rs.min_duration_ms);
  check(
    `모든 큐 노출 ≥ ${rs.min_duration_ms}ms`,
    short.length === 0,
    JSON.stringify(short.map((c) => ({ dur: c.end_ms - c.start_ms, lines: c.lines }))),
  );
}

console.log("case 5: 가사 ♪ 가중치도 산술 이전에 반영 (II.7)");
{
  const segs = [
    { start_ms: 0, end_ms: 2000, text: "가나다라마바사아자차카타파 나다라마바사아자차카타파하", kind: "lyrics" },
  ];
  const built = buildCues(segs, rs, { speaker_labels: true });
  const audit = auditCues(built.cues, rs);
  check(
    "미선언 텍스트 소관 위반 없음 (♪ 포함 CPS)",
    undeclaredTextViolations(audit, built).length === 0,
    JSON.stringify(undeclaredTextViolations(audit, built)),
  );
  check(
    "♪ 짝 위반 없음",
    !audit.some((v) => v.rule === "unpaired_music_note"),
    JSON.stringify(audit.filter((v) => v.rule === "unpaired_music_note")),
  );
  check("서버 소관 위반 0건", serverViolations(audit).length === 0, JSON.stringify(serverViolations(audit)));
}

if (failed) {
  console.error(`\n❌ C-1 회귀 ${failed}건 실패`);
  process.exit(1);
}
console.log("\n✅ C-1 회귀 테스트 통과");
