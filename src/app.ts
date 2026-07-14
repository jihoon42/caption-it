/**
 * 캡션잇 (CAPTION-IT) — 접근성 자막 파이프라인 MCP 서버 (앱 구성)
 *
 * 링킷(hearing-mcp)의 자매 서버.
 *  - 링킷 = 소통이 성립할 조건(정성 레이어: 프로필·가이드·증언)
 *  - 캡션잇 = 남겨진 소리를 읽히게 만드는 도구(사실·산술 레이어: 전사·자막 규격 엔진)
 *
 * 아키텍처 원칙 (링킷과 동일):
 *  - 요약·의역·소리 묘사 선택 = 클라이언트 LLM / 산술·규격 판정·형식 변환 = 서버(결정론)
 *  - 서버는 개인정보를 영속화하지 않는다. 오디오·전사는 어디에도 저장되지 않는다(무저장 처리).
 *  - 실시간 자막이 아니다. 회의 녹음·강의·영상 등 "남겨진 기록"의 비실시간 처리다.
 *  - transport: Streamable HTTP (stateless) — PlayMCP in KC 배포 형식
 *
 * 이 파일은 buildServer()/createApp()만 export한다 — 포트 바인딩 같은 기동
 * side-effect는 index.ts(엔트리포인트) 소관. demo.mjs·테스트가 임시 포트로
 * 같은 앱을 띄울 수 있게 하기 위한 분리이며, 도구 동작·스키마·응답은 불변.
 */
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  Audience,
  CaptionMode,
  STANDARD_SOURCES,
  SupportBand,
  getRuleset,
} from "./standards.js";
import {
  Segment,
  SoundEvent,
  auditCues,
  autofixCues,
  buildCues,
  cueStats,
  emitSrt,
  emitVtt,
  insertSoundEvents,
  parseCaptions,
  splitSentences,
} from "./engine.js";
import { SAMPLES, SAMPLE_NOTICE } from "./samples.js";
import { availableProviders, providerSetupGuide, transcribe } from "./stt.js";
import { weightedLength } from "./standards.js";

export const SERVICE = "caption-it";
export const VERSION = "0.1.0";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const segmentShape = z.object({
  start_ms: z.number().int().nonnegative().describe("발화 시작(밀리초)"),
  end_ms: z.number().int().nonnegative().describe("발화 종료(밀리초)"),
  text: z.string().min(1).max(2000).describe("발화 원문 (축약·의역하지 말 것)"),
  speaker: z.string().max(40).optional().describe("화자 라벨 (예: '진행자'). 실명 대신 역할 호칭 권장"),
  kind: z.enum(["dialogue", "lyrics"]).optional().describe("lyrics면 ♪ … ♪로 표기 (기본 dialogue)"),
});

const MODE_DESC =
  "sdh(청각장애인용 자막: 화자·소리 정보 포함, CPS 성인 14/아동 11) 또는 " +
  "standard(일반 자막: CPS 성인 12/아동 9). 기본 sdh";
const BAND_DESC =
  "링킷(hearing-mcp) create_communication_profile 응답의 support_band를 그대로 전달하면 " +
  "intensive일 때 읽기 속도·최소 노출 시간을 보수적으로 조정합니다 (의료적 판정이 아닌 표시 시간 매핑)";

export function buildServer(): McpServer {
  const server = new McpServer({ name: SERVICE, version: VERSION });

  server.registerTool(
    "transcribe_media",
    {
      title: "미디어 전사 (STT)",
      description:
        "공개 URL의 음성/영상 파일을 STT로 전사해 타임스탬프 세그먼트를 반환합니다. " +
        "실시간 자막이 아니라 회의 녹음·강의·영상 같은 '남겨진 기록'의 비실시간 처리입니다. " +
        "결과 segments를 build_accessible_captions에 그대로 전달하면 규격 자막이 나옵니다. " +
        "STT 프로바이더(CLOVA/Azure/OpenAI)는 서버 환경 변수로 설정되며, 설정이 없으면 활성화 방법을 안내합니다. " +
        "키 없이 체험하려면 sample_id(list_sample_media 참조)를 사용하세요. " +
        "오디오와 전사 결과는 서버에 저장되지 않습니다.",
      inputSchema: {
        audio_url: z.string().url().optional().describe("공개 접근 가능한 오디오/비디오 URL (25MB 이하)"),
        sample_id: z.string().optional().describe("내장 샘플 ID (키·URL 불필요, list_sample_media로 조회)"),
        language: z.string().default("ko-KR").describe("언어 코드 (기본 ko-KR)"),
        diarization: z.boolean().default(false).describe("화자 분리 시도 (CLOVA/Azure 지원)"),
        provider: z.enum(["clova", "azure", "openai", "mock"]).optional().describe("프로바이더 강제 지정 (기본: 서버 설정)"),
      },
    },
    async (args: {
      audio_url?: string;
      sample_id?: string;
      language: string;
      diarization: boolean;
      provider?: "clova" | "azure" | "openai" | "mock";
    }) => {
      try {
        const result = await transcribe(args);
        return json({
          ...result,
          ...(result.is_demo ? { demo_notice: SAMPLE_NOTICE } : {}),
          privacy_note: "오디오와 전사 결과는 서버에 저장되지 않았습니다 (무저장 처리).",
          next_steps:
            "segments를 build_accessible_captions에 그대로 전달하세요. " +
            "화자 라벨이 비어 있고 대화가 여러 명이라면, 사용자에게 화자를 확인해 speaker를 채우면 SDH 품질이 올라갑니다.",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          return json(JSON.parse(msg)); // stt.ts가 구조화 안내를 던진 경우
        } catch {
          return json({
            error: msg,
            available_providers: availableProviders(),
            hint: "sample_id로 체험하거나, 전사 텍스트가 이미 있으면 build_accessible_captions에 직접 전달하세요.",
          });
        }
      }
    },
  );

  server.registerTool(
    "build_accessible_captions",
    {
      title: "접근성 자막 생성",
      description:
        "타임스탬프 세그먼트(또는 타임스탬프 없는 전사 텍스트)를 한국어 접근성 자막 규격에 맞는 WebVTT/SRT로 변환합니다. " +
        "규격: 줄당 16자(라틴·공백 0.5자 가중)·최대 2줄·읽기 속도 상한·최소 노출 5/6초·화자 [이름] 표기·가사 ♪ 표기 " +
        "(Netflix Korean TTSG + 방통위 가이드라인, 근거는 guides://caption-standards 리소스). " +
        "서버는 어휘를 바꾸지 않습니다 — 표시 시간 연장으로 읽기 속도를 못 맞추는 큐는 needs_text_reduction으로 " +
        "표시되며, 축약은 에이전트가 사용자와 함께 결정하세요. " +
        "소리 정보(sound_events)는 줄거리에 중요한 소리만: 어떤 소리가 중요한지는 에이전트/사용자의 판단입니다. " +
        BAND_DESC,
      inputSchema: {
        segments: z.array(segmentShape).max(2000).optional().describe("타임스탬프 세그먼트 (transcribe_media 결과 그대로)"),
        plain_text: z.string().max(50_000).optional().describe("타임스탬프 없는 전사 원문 (segments가 없을 때)"),
        total_duration_ms: z.number().int().positive().optional().describe("plain_text 사용 시 전체 길이(밀리초) — 필수"),
        format: z.enum(["vtt", "srt", "both"]).default("vtt").describe("출력 형식"),
        mode: z.enum(["sdh", "standard"]).default("sdh").describe(MODE_DESC),
        audience: z.enum(["adult", "children"]).default("adult").describe("시청 대상 (아동 콘텐츠면 children)"),
        support_band: z.enum(["light", "standard", "intensive"]).optional().describe(BAND_DESC),
        speaker_labels: z.boolean().default(true).describe("SDH에서 화자 전환 시 [화자] 라벨 부착"),
        sound_events: z
          .array(
            z.object({
              at_ms: z.number().int().nonnegative().describe("소리 발생 시각(밀리초)"),
              label: z.string().min(1).max(30).describe("소리 묘사 — 의성어 우선 (예: '박수', '펑!', '잔잔한 음악')"),
              kind: z.enum(["sound", "music"]).optional(),
            }),
          )
          .max(100)
          .optional()
          .describe("줄거리에 중요한 소리 정보 [효과음] 큐로 삽입"),
      },
    },
    async (args: {
      segments?: Segment[];
      plain_text?: string;
      total_duration_ms?: number;
      format: "vtt" | "srt" | "both";
      mode: CaptionMode;
      audience: Audience;
      support_band?: SupportBand;
      speaker_labels: boolean;
      sound_events?: SoundEvent[];
    }) => {
      const ruleset = getRuleset(args.mode, args.audience, args.support_band);

      let segments: Segment[] | undefined = args.segments;
      let timingNote: string | undefined;
      if (!segments?.length) {
        if (!args.plain_text?.trim() || !args.total_duration_ms) {
          return json({
            error: "segments 또는 (plain_text + total_duration_ms) 중 하나는 필요합니다.",
            hint: "타임스탬프가 있으면 segments가 정확합니다. transcribe_media 결과를 그대로 전달하세요.",
          });
        }
        // 타임스탬프 없는 텍스트: 문장 가중치 비례로 시간 배분 (근사임을 명시)
        const sentences = splitSentences(args.plain_text.replace(/\s+/g, " ").trim());
        const totalW = sentences.reduce((s, p) => s + weightedLength(p), 0) || 1;
        let t = 0;
        segments = sentences.map((s, i) => {
          const dur = (args.total_duration_ms! * weightedLength(s)) / totalW;
          const seg: Segment = { start_ms: Math.round(t), end_ms: Math.round(t + dur), text: s };
          t += dur;
          return i === sentences.length - 1 ? { ...seg, end_ms: args.total_duration_ms! } : seg;
        });
        timingNote =
          "타임스탬프가 없어 문장 길이 비례로 시간을 근사 배분했습니다. " +
          "실제 발화 타이밍과 다를 수 있으니 정밀 동기화가 필요하면 transcribe_media로 타임스탬프를 얻으세요.";
      }
      const invalid = segments.find((s) => s.end_ms <= s.start_ms);
      if (invalid) {
        return json({ error: `end_ms가 start_ms보다 커야 합니다: "${invalid.text.slice(0, 30)}"` });
      }

      const built = buildCues(segments, ruleset, { speaker_labels: args.speaker_labels });
      let soundReport;
      if (args.sound_events?.length) {
        soundReport = insertSoundEvents(built.cues, args.sound_events, ruleset);
        built.fix_log.push(...soundReport.log);
      }

      const stats = cueStats(built.cues, ruleset);
      return json({
        ...(args.format !== "srt" ? { vtt: emitVtt(built.cues) } : {}),
        ...(args.format !== "vtt" ? { srt: emitSrt(built.cues) } : {}),
        stats,
        applied_ruleset: ruleset,
        fix_log: built.fix_log,
        needs_attention: built.violations,
        ...(soundReport?.unplaced.length ? { unplaced_sound_events: soundReport.unplaced } : {}),
        ...(timingNote ? { timing_note: timingNote } : {}),
        content_integrity:
          "서버는 어휘를 변경하지 않았습니다. 허용된 표기 교정(말줄임표 통일, 줄 끝 마침표 제거 등)은 fix_log에 전부 기록되어 있습니다.",
        next_steps:
          "needs_attention에 needs_text_reduction이 있으면 해당 큐의 축약안을 사용자와 함께 만들어 segments를 수정 후 재호출하세요. " +
          "완성본 검증은 audit_captions로 할 수 있습니다.",
      });
    },
  );

  server.registerTool(
    "audit_captions",
    {
      title: "자막 감사·보정",
      description:
        "기존 WebVTT/SRT 자막(유튜브 자동 자막 내보내기 등)을 한국어 접근성 규격으로 감사하고, " +
        "내용을 바꾸지 않는 범위에서 자동 보정본을 만듭니다. " +
        "검사: 읽기 속도(CPS)·줄당 자수·줄 수·노출 시간·큐 겹침·간격·줄 끝 구두점·말줄임표·가사 ♪ 짝·화자/소리 정보 유무(SDH). " +
        "보정: 표기·줄바꿈·타이밍만. 텍스트 축약(의역)은 내용 판단이므로 하지 않으며 위반으로 보고만 합니다. " +
        "자막이 아예 없는 콘텐츠는 transcribe_media → build_accessible_captions 경로를 사용하세요.",
      inputSchema: {
        caption_text: z.string().min(1).max(200_000).describe("WebVTT 또는 SRT 원문 (형식 자동 감지)"),
        mode: z.enum(["sdh", "standard"]).default("sdh").describe(MODE_DESC),
        audience: z.enum(["adult", "children"]).default("adult").describe("시청 대상"),
        support_band: z.enum(["light", "standard", "intensive"]).optional().describe(BAND_DESC),
        autofix: z.boolean().default(true).describe("내용 불변 자동 보정본 생성 여부"),
        output_format: z.enum(["same", "vtt", "srt", "both"]).default("same").describe("보정본 출력 형식 (same=입력과 동일)"),
      },
    },
    async (args: {
      caption_text: string;
      mode: CaptionMode;
      audience: Audience;
      support_band?: SupportBand;
      autofix: boolean;
      output_format: "same" | "vtt" | "srt" | "both";
    }) => {
      const ruleset = getRuleset(args.mode, args.audience, args.support_band);
      const parsed = parseCaptions(args.caption_text);
      if (parsed.format === "unknown" || parsed.cues.length === 0) {
        return json({
          error: "WebVTT/SRT로 해석할 수 있는 큐가 없습니다.",
          syntax_errors: parsed.syntax_errors,
          hint: "자막 파일 원문 전체를 caption_text로 전달했는지 확인하세요. 전사 텍스트라면 build_accessible_captions를 사용하세요.",
        });
      }
      const violations = auditCues(parsed.cues, ruleset);
      const bySeverity = {
        error: violations.filter((v) => v.severity === "error").length,
        warn: violations.filter((v) => v.severity === "warn").length,
        info: violations.filter((v) => v.severity === "info").length,
      };
      let fixed;
      if (args.autofix && violations.some((v) => v.severity !== "info")) {
        const fix = autofixCues(parsed.cues, ruleset);
        const fmt = args.output_format === "same" ? parsed.format : args.output_format;
        fixed = {
          ...(fmt === "vtt" || fmt === "both" ? { vtt: emitVtt(fix.cues) } : {}),
          ...(fmt === "srt" || fmt === "both" ? { srt: emitSrt(fix.cues) } : {}),
          fix_log: fix.fix_log,
          remaining_violations: fix.unresolved,
          stats_after: cueStats(fix.cues, ruleset),
          content_integrity:
            "보정은 표기·줄바꿈·타이밍만 변경했습니다. 어휘·문장은 그대로입니다. " +
            "remaining_violations의 cps_exceeded는 텍스트 축약 없이는 해결 불가 — 축약은 사용자와 함께 결정하세요.",
        };
      }
      return json({
        format_detected: parsed.format,
        syntax_errors: parsed.syntax_errors,
        stats_before: cueStats(parsed.cues, ruleset),
        applied_ruleset: ruleset,
        violation_summary: bySeverity,
        violations,
        ...(fixed ? { fixed } : {}),
        next_steps:
          bySeverity.error === 0 && bySeverity.warn === 0
            ? "이 자막은 적용 규격을 통과했습니다."
            : "사용자에게 위반 요약을 알기 쉽게 설명하고, 보정본 사용 여부를 확인하세요.",
      });
    },
  );

  server.registerTool(
    "list_sample_media",
    {
      title: "체험용 샘플 목록",
      description:
        "STT 키·오디오 URL 없이 파이프라인을 체험할 수 있는 내장 합성 샘플 목록을 반환합니다. " +
        "전원 가상 콘텐츠이며 실제 회의·강의가 아닙니다. " +
        "사용법: transcribe_media에 sample_id를 전달 → 반환된 segments를 build_accessible_captions로.",
      inputSchema: {},
    },
    async () =>
      json({
        samples: SAMPLES.map(({ segments, ...meta }) => ({ ...meta, segment_count: segments.length })),
        demo_notice: SAMPLE_NOTICE,
      }),
  );

  server.registerResource(
    "caption-standards",
    "guides://caption-standards",
    {
      title: "접근성 자막 규격 룰북 (근거·출처 포함)",
      description:
        "캡션잇이 적용하는 자막 규격 수치 전체와 출처. 생성(build)과 감사(audit)가 같은 룰북을 공유합니다.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              rulesets: {
                "sdh-adult": getRuleset("sdh", "adult"),
                "sdh-children": getRuleset("sdh", "children"),
                "standard-adult": getRuleset("standard", "adult"),
                "standard-children": getRuleset("standard", "children"),
                "sdh-adult-intensive(링킷 support_band 연동)": getRuleset("sdh", "adult", "intensive"),
              },
              character_weighting:
                "한글 음절·자모·CJK·전각 기호 = 1자, 라틴·숫자·공백·반각 구두점 = 0.5자 (Netflix Korean TTSG I.2)",
              sdh_conventions: {
                speaker_id: "[이름] — 화면만으로 화자를 식별할 수 없는 지점·화자 전환 지점에 부착 (II.8)",
                sound_effects: "[효과음] — 의성어 우선, 시각 묘사 대신 소리 묘사 (II.9)",
                lyrics: "♪ 가사 ♪ — 양 끝에 음표, 음표와 텍스트 사이 공백 (II.7)",
                dual_source: "- 대사 / - [효과음] — 서로 다른 소리원은 하이픈으로 구분 (II.5)",
              },
              content_policy:
                "서버는 어휘를 변경하지 않는다. 표기 교정(… 통일, 줄 끝 마침표 제거)만 수행하며 전부 fix_log에 기록된다. " +
                "읽기 속도 위반이 시간 연장으로 해결되지 않으면 needs_text_reduction으로 보고하고 축약 판단은 에이전트/사람에게 넘긴다.",
              support_band_mapping:
                "링킷 support_band=intensive → 해당 모드의 아동 등급 CPS + 최소 노출 1초. " +
                "의료적 판정이 아니라 '표시 시간을 얼마나 보수적으로 줄 것인가'의 매핑이다.",
              sources: STANDARD_SOURCES,
              stt_providers: providerSetupGuide(),
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}

/** express 앱 구성 — listen은 하지 않는다 (엔트리포인트/데모/테스트가 포트를 결정) */
export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: SERVICE, stt_available: availableProviders() });
  });

  // Streamable HTTP, stateless: 요청마다 서버·트랜스포트 인스턴스 생성 (링킷과 동일)
  app.post("/mcp", async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST /mcp (stateless streamable HTTP)." },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}
