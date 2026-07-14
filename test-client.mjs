/**
 * 캡션잇 v0.1 전체 시나리오 스모크 테스트 (13종)
 * 시나리오: "회의 녹음을 자막으로 만들어줘" / "유튜브에서 받은 자막 좀 점검해줘"
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = process.env.MCP_URL ?? "http://localhost:8080/mcp";
const client = new Client({ name: "test-client", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));

const parse = (r) => JSON.parse(r.content[0].text);
const fail = (msg) => { throw new Error(`❌ ${msg}`); };

// 1. 도구 목록 (4개)
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
if (tools.tools.length !== 4) fail(`도구가 4개가 아님: ${tools.tools.length}`);

// 2. 샘플 목록 (2개 + 고지)
const samples = parse(await client.callTool({ name: "list_sample_media", arguments: {} }));
if (samples.samples.length !== 2) fail(`샘플이 2개가 아님: ${samples.samples.length}`);
if (!samples.demo_notice) fail("demo_notice 없음");
console.log("samples:", samples.samples.map((s) => s.id).join(", "));

// 3. 샘플 전사 (mock, 키 불필요)
const tr = parse(await client.callTool({
  name: "transcribe_media",
  arguments: { sample_id: "demo_meeting" },
}));
if (tr.provider !== "mock") fail(`샘플 전사 프로바이더가 mock이 아님: ${tr.provider}`);
if (!tr.segments?.length) fail("전사 세그먼트 없음");
if (!tr.demo_notice) fail("전사 결과에 demo_notice 없음");
if (!tr.privacy_note) fail("privacy_note 없음");
console.log(`transcribe(demo_meeting): ${tr.segments.length} segments`);

// 4. 자막 생성 (SDH 성인, VTT+SRT)
const built = parse(await client.callTool({
  name: "build_accessible_captions",
  arguments: { segments: tr.segments, format: "both" },
}));
if (!built.vtt?.startsWith("WEBVTT")) fail("VTT 헤더 없음");
if (!built.srt?.startsWith("1\n")) fail("SRT 인덱스 없음");
if (built.stats.max_cps > built.stats.cps_limit) fail(`생성 자막이 CPS 상한 초과: ${built.stats.max_cps}`);
if (!built.vtt.includes("[진행자]")) fail("화자 라벨 [진행자] 없음");
if (!built.content_integrity) fail("content_integrity 선언 없음");
console.log(`build: ${built.stats.cue_count} cues, max ${built.stats.max_cps}/${built.stats.cps_limit} CPS`);

// 5. 생성 결과를 다시 감사 → error 0이어야 함
const roundtrip = parse(await client.callTool({
  name: "audit_captions",
  arguments: { caption_text: built.vtt, autofix: false },
}));
if (roundtrip.violation_summary.error !== 0)
  fail(`생성 자막 재감사에서 error 발생: ${JSON.stringify(roundtrip.violations.filter(v => v.severity === "error"))}`);
console.log(`roundtrip audit: error 0, warn ${roundtrip.violation_summary.warn}, info ${roundtrip.violation_summary.info}`);

// 6. 링킷 연동 — support_band=intensive → 아동 등급 CPS(11)로 강화
const intensive = parse(await client.callTool({
  name: "build_accessible_captions",
  arguments: { segments: tr.segments, support_band: "intensive" },
}));
if (intensive.applied_ruleset.max_cps !== 11) fail(`intensive CPS가 11이 아님: ${intensive.applied_ruleset.max_cps}`);
if (intensive.applied_ruleset.min_duration_ms !== 1000) fail("intensive 최소 노출이 1000ms가 아님");
console.log(`support_band=intensive: CPS ${intensive.applied_ruleset.max_cps}, min ${intensive.applied_ruleset.min_duration_ms}ms`);

// 7. 타임스탬프 없는 전사 → 근사 배분
const plain = parse(await client.callTool({
  name: "build_accessible_captions",
  arguments: {
    plain_text: "안녕하세요. 오늘은 자막 이야기를 해 보겠습니다. 자막은 모두에게 도움이 됩니다.",
    total_duration_ms: 12000,
  },
}));
if (!plain.vtt) fail("plain_text 경로에서 VTT 없음");
if (!plain.timing_note) fail("근사 배분 timing_note 없음");
console.log(`plain_text: ${plain.stats.cue_count} cues + timing_note OK`);

// 8. 효과음 삽입
const withSound = parse(await client.callTool({
  name: "build_accessible_captions",
  arguments: { segments: tr.segments, sound_events: [{ at_ms: 77000, label: "박수" }] },
}));
if (!withSound.vtt.includes("[박수]")) fail("[박수] 효과음 큐 없음");
console.log("sound_events: [박수] 삽입 OK");

// 9. 가사 표기 (♪ … ♪)
const lyrics = parse(await client.callTool({
  name: "build_accessible_captions",
  arguments: { segments: [{ start_ms: 0, end_ms: 4000, text: "기억하렴 나의 서글픈 모습", kind: "lyrics" }] },
}));
if (!lyrics.vtt.includes("♪")) fail("가사 ♪ 표기 없음");
console.log("lyrics: ♪ 표기 OK");

// 10. 고장난 자막 감사 — 의도적 위반 5종
const brokenVtt = `WEBVTT

00:00:00.000 --> 00:00:01.000
이 문장은 일부러 아주 길게 써서 읽기 속도와 줄 길이 규칙을 동시에 위반하게 만들었습니다.

00:00:00.500 --> 00:00:02.000
겹치는 큐입니다...

00:00:02.100 --> 00:00:02.300
짧다.
`;
const audit = parse(await client.callTool({
  name: "audit_captions",
  arguments: { caption_text: brokenVtt },
}));
const rules = audit.violations.map((v) => v.rule);
for (const expected of ["cps_exceeded", "overlap", "duration_too_short", "ascii_ellipsis", "trailing_punct"])
  if (!rules.includes(expected)) fail(`감사에서 ${expected} 미검출 (검출: ${rules.join(",")})`);
if (!audit.fixed) fail("autofix 보정본 없음");
if (!audit.fixed.fix_log.length) fail("fix_log 비어 있음");
console.log(`audit(broken): ${audit.violations.length} violations 검출 + 보정본 생성 OK`);

// 11. 보정본 재감사 — error가 남으면 remaining_violations로 정직하게 보고되는지
const refix = parse(await client.callTool({
  name: "audit_captions",
  arguments: { caption_text: audit.fixed.vtt, autofix: false },
}));
const remainingErrors = refix.violations.filter((v) => v.severity === "error");
const declaredRemaining = audit.fixed.remaining_violations.filter((v) => v.severity === "error");
if (remainingErrors.length !== declaredRemaining.length)
  fail(`보정본 잔여 error 불일치: 실제 ${remainingErrors.length} vs 선언 ${declaredRemaining.length}`);
console.log(`refix audit: 잔여 error ${remainingErrors.length}건 — 선언과 일치 (축약 필요분)`);

// 12. SRT 입력 감사 (형식 자동 감지)
const srtIn = `1
00:00:00,000 --> 00:00:03,000
첫 번째 자막입니다

2
00:00:03,100 --> 00:00:06,000
두 번째 자막입니다
`;
const srtAudit = parse(await client.callTool({
  name: "audit_captions",
  arguments: { caption_text: srtIn, mode: "standard" },
}));
if (srtAudit.format_detected !== "srt") fail(`SRT 감지 실패: ${srtAudit.format_detected}`);
console.log("srt detect + audit OK");

// 13. STT 미설정 시 구조화 안내 (에러로 죽지 않음)
const noKey = parse(await client.callTool({
  name: "transcribe_media",
  arguments: { audio_url: "https://example.com/audio.mp3" },
}));
if (!noKey.error && !noKey.segments) fail("미설정 프로바이더 처리 실패");
if (noKey.error && !noKey.how_to_enable && !noKey.hint) fail("설정 안내 없음");
console.log("no-key guidance OK");

// 리소스 확인
const res = await client.readResource({ uri: "guides://caption-standards" });
const standards = JSON.parse(res.contents[0].text);
if (!standards.sources?.length) fail("규격 리소스에 출처 없음");
if (!standards.rulesets) fail("규격 리소스에 룰셋 없음");
console.log("resource caption-standards OK");

console.log("\n✅ 캡션잇 전체 시나리오 13종 통과");
process.exit(0);
