/**
 * 캡션잇 30초 셀프 데모 — STT 키·외부 네트워크 없이 전체 파이프라인 체험
 *
 *   npm ci && npm run build && npm run demo
 *
 * ① 내장 샘플 전사(mock STT) → ② 규격 자막 생성(WebVTT) + 생성물 재감사
 * ③ 일부러 고장 낸 자막 → 감사(위반 리포트) → 내용 불변 자동 보정 before/after
 *
 * 서버는 임시 포트(127.0.0.1)에 인프로세스로 뜨며 외부로 나가는 요청이 없다.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const t0 = Date.now();

const appModule = await import("./build/app.js").catch(() => null);
if (!appModule) {
  console.error("build/app.js가 없습니다. 먼저 `npm run build`를 실행하세요.");
  process.exit(1);
}

const app = appModule.createApp();
const httpServer = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const port = httpServer.address().port;

const client = new Client({ name: "caption-it-demo", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
const call = async (name, args) =>
  JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const W = 66;
const section = (title) => console.log(`\n${"━".repeat(W)}\n${title}\n${"━".repeat(W)}`);
const indent = (text, pad = "  ") =>
  String(text).trimEnd().split("\n").map((l) => pad + l).join("\n");

console.log("캡션잇(CAPTION-IT) 데모 — 회의 녹음이 규격 자막이 되기까지");
console.log("(STT 키 없음 · 외부 네트워크 없음 · 전 과정 결정론)");

// ── ① 전사 ──────────────────────────────────────────────────────
section("① 전사 — transcribe_media(sample_id: demo_meeting)");
const tr = await call("transcribe_media", { sample_id: "demo_meeting" });
console.log(`  내장 샘플(가상 회의, ${Math.round(tr.duration_ms / 1000)}초) → 세그먼트 ${tr.segments.length}개`);
for (const s of tr.segments.slice(0, 3))
  console.log(`    ${(s.start_ms / 1000).toFixed(1)}s [${s.speaker}] ${s.text}`);
console.log(`    … (이하 ${tr.segments.length - 3}개 생략)`);
console.log(`  ※ ${tr.privacy_note}`);

// ── ② 자막 생성 ────────────────────────────────────────────────
section("② 자막 생성 — build_accessible_captions (SDH, 성인)");
const built = await call("build_accessible_captions", { segments: tr.segments, format: "vtt" });
const vttHead = built.vtt.split("\n\n").slice(0, 5).join("\n\n");
console.log(indent(vttHead));
console.log(`  … (전체 ${built.stats.cue_count}개 큐)`);
console.log("");
console.log(`  자동 적용된 규격: 화자 [이름] 라벨, 줄당 16자(가중)·최대 2줄,`);
console.log(`  읽기 속도 ${built.stats.cps_limit} CPS 이하(현재 최대 ${built.stats.max_cps}), 최소 노출 5/6초, 큐 간격 확보`);
console.log(`  표기 교정 기록(fix_log): ${built.fix_log.length}건 — 어휘는 1글자도 바꾸지 않음`);

const roundtrip = await call("audit_captions", { caption_text: built.vtt, autofix: false });
console.log(
  `  생성물 재감사(audit_captions): error ${roundtrip.violation_summary.error} · ` +
    `warn ${roundtrip.violation_summary.warn} — 생성과 감사가 같은 룰북을 공유`,
);

// ── ③ 고장 자막 감사·보정 ──────────────────────────────────────
section("③ 기존 자막 점검 — 일부러 고장 낸 자막을 audit_captions에");
const brokenVtt = `WEBVTT

00:00:00.000 --> 00:00:01.000
이 자막은 일부러 규격을 어겨서
읽기 속도와 줄 수 제한을
동시에 위반하게 만들었습니다,

00:00:00.500 --> 00:00:02.000
앞 큐와 시간이 겹치는 큐입니다...

00:00:02.100 --> 00:00:02.400
노출이 너무 짧은 큐
`;
console.log("  [BEFORE] 고장 자막 (빠른 CPS·3줄·겹침·'...'·줄 끝 쉼표):");
console.log(indent(brokenVtt, "  │ "));

const audit = await call("audit_captions", { caption_text: brokenVtt });
console.log(`\n  위반 리포트 (${audit.violations.length}건):`);
for (const v of audit.violations)
  console.log(`    · [${v.severity}] ${v.rule}${v.cue_index ? ` (큐 ${v.cue_index})` : ""} — 발견 ${v.found} / 기준 ${v.limit}`);

console.log("\n  [AFTER] 내용 불변 자동 보정본 (표기·줄바꿈·타이밍만 수정):");
console.log(indent(audit.fixed.vtt, "  │ "));
console.log(`  보정 내역(fix_log) ${audit.fixed.fix_log.length}건, 잔여 위반 ${audit.fixed.remaining_violations.length}건 (숨기지 않고 보고):`);
for (const v of audit.fixed.remaining_violations) {
  const note =
    v.rule === "cps_exceeded"
      ? "텍스트 축약 없이는 해결 불가 — 서버는 어휘를 줄이지 않고 보고만 합니다"
      : `${v.found} (기준 ${v.limit})`;
  console.log(`    · ${v.rule} (큐 ${v.cue_index}) — ${note}`);
}

// ── 마무리 ──────────────────────────────────────────────────────
section("요약");
console.log("  · 전사 → 규격 자막 생성 → 감사·보정이 하나의 룰북(Netflix Korean TTSG 수치)으로 돌아갑니다.");
console.log("  · 서버는 어휘를 바꾸지 않습니다. 모든 표기 교정은 fix_log에, 축약 필요분은 위반으로 정직하게 보고됩니다.");
console.log("  · 실제 오디오는 transcribe_media에 URL을 주면 됩니다 (STT 키 설정은 README §7).");
console.log(`\n완료 — ${((Date.now() - t0) / 1000).toFixed(1)}초, 외부 네트워크·STT 키 사용 없음`);

await client.close();
httpServer.close();
process.exit(0);
