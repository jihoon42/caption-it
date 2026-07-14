/**
 * 캡션잇 (CAPTION-IT) — 접근성 자막 규격 정의
 *
 * 이 파일은 서버의 "룰북"이다. 모든 수치는 공개 표준에서 가져왔고 출처를 명시한다.
 * 규격은 코드가 아니라 데이터로 존재해야 감사(audit)와 생성(build)이 같은 근거를 공유한다.
 *
 * 근거 문서:
 *  - Netflix Korean Timed Text Style Guide (I.2/I.15/II.2/II.3/II.8/II.9 등)
 *  - 방송통신위원회 「장애인방송 프로그램 제공 가이드라인」 (화자 구분·자막 표기 원칙)
 *  - W3C WebVTT: The Web Video Text Tracks Format
 */

export type Audience = "adult" | "children";
export type CaptionMode = "sdh" | "standard";
/** 링킷(hearing-mcp) create_communication_profile 응답의 support_band와 동일 어휘 */
export type SupportBand = "light" | "standard" | "intensive";

export interface Ruleset {
  id: string;
  mode: CaptionMode;
  audience: Audience;
  /** 초당 가중 글자 수 상한 (한글/전각 1, 라틴·공백·구두점 0.5) */
  max_cps: number;
  /** 줄당 가중 글자 수 상한 */
  max_line_weight: number;
  /** 큐당 최대 줄 수 */
  max_lines: number;
  /** 큐 최소 노출 시간 (5/6초) */
  min_duration_ms: number;
  /** 큐 최대 노출 시간 */
  max_duration_ms: number;
  /** 인접 큐 최소 간격 (2프레임 @ 24fps 근사) */
  min_gap_ms: number;
}

/**
 * 읽기 속도(CPS) 상한 — Netflix Korean TTSG
 *  - 일반 자막(interlingual):  성인 12 / 아동 9   (I.15)
 *  - SDH(청각장애인용 자막):   성인 14 / 아동 11  (II.3)
 * SDH가 더 높은 이유: 원 대사를 최대한 보존하는 것이 원칙이기 때문 (II.1).
 */
const CPS_TABLE: Record<CaptionMode, Record<Audience, number>> = {
  standard: { adult: 12, children: 9 },
  sdh: { adult: 14, children: 11 },
};

export const LINE_WEIGHT_LIMIT = 16; // 줄당 16자 (라틴·공백·구두점 0.5자) — I.2/II.2
export const MAX_LINES = 2; //          최대 2줄 — I.11/II.4
export const MIN_DURATION_MS = 833; //  5/6초 — Netflix Timed Text 일반 요구사항
export const MAX_DURATION_MS = 7000; // 7초
export const MIN_GAP_MS = 84; //        2프레임(@23.976fps) 근사

export function getRuleset(
  mode: CaptionMode,
  audience: Audience,
  supportBand?: SupportBand,
): Ruleset {
  // 링킷 support_band 연동 — 보수적 매핑:
  // intensive(축 3개+ 또는 masking)는 정보처리(축 D) 부담을 포함할 수 있으므로
  // 해당 모드의 아동 등급 CPS를 적용하고 최소 노출 시간을 1초로 올린다.
  // 이것은 의료적 판정이 아니라 "표시 시간을 얼마나 보수적으로 줄 것인가"의 매핑이다.
  const effectiveAudience: Audience =
    supportBand === "intensive" ? "children" : audience;
  return {
    id: `ko-${mode}-${effectiveAudience}${supportBand === "intensive" ? "-intensive" : ""}`,
    mode,
    audience,
    max_cps: CPS_TABLE[mode][effectiveAudience],
    max_line_weight: LINE_WEIGHT_LIMIT,
    max_lines: MAX_LINES,
    min_duration_ms: supportBand === "intensive" ? 1000 : MIN_DURATION_MS,
    max_duration_ms: MAX_DURATION_MS,
    min_gap_ms: MIN_GAP_MS,
  };
}

/** 규격 출처 — 모든 항목에 last_verified 명시 (링킷과 동일 원칙) */
export const STANDARD_SOURCES = [
  {
    title: "Netflix Korean Timed Text Style Guide",
    url: "https://partnerhelp.netflixstudios.com/hc/en-us/articles/216001127-Korean-Timed-Text-Style-Guide",
    grounds:
      "줄당 16자(라틴·공백·구두점 0.5자 가중), 최대 2줄, CPS 상한(일반 12/9·SDH 14/11), " +
      "화자 표시 [이름], 효과음 [의성어] 원칙, 가사 ♪ 표기, 줄 끝 마침표·쉼표 금지, 말줄임표 U+2026",
    last_verified: "2026-07-14",
  },
  {
    title: "방송통신위원회 「장애인방송 프로그램 제공 가이드라인」",
    url: "https://kcc.go.kr/user.do?mode=view&page=A02030700&boardId=1099&boardSeq=47390",
    grounds: "폐쇄자막의 자막 표기 방법·화자 구분 제공 원칙 (국내 규제 근거)",
    last_verified: "2026-07-14",
  },
  {
    title: "장애인방송 편성 및 제공 등 장애인 방송접근권 보장에 관한 고시",
    url: "https://www.law.go.kr/LSW/admRulLsInfoP.do?admRulSeq=2100000175818",
    grounds: "장애인방송(폐쇄자막 포함) 제공 의무의 법적 근거",
    last_verified: "2026-07-14",
  },
  {
    title: "W3C WebVTT: The Web Video Text Tracks Format",
    url: "https://www.w3.org/TR/webvtt1/",
    grounds: "WebVTT 파일 구조·타임스탬프·이스케이프 규칙",
    last_verified: "2026-07-14",
  },
] as const;

/**
 * 가중 글자 수 — Netflix Korean TTSG I.2:
 * "16 characters per line — Latin characters, spaces, punctuation count as 0.5 character"
 * 한글 음절·자모·CJK·전각 기호 = 1, 그 외(라틴·숫자·공백·반각 구두점) = 0.5
 */
export function weightedLength(text: string): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isFullWidth(cp) ? 1 : 0.5;
  }
  return w;
}

function isFullWidth(cp: number): boolean {
  return (
    (cp >= 0xac00 && cp <= 0xd7a3) || // 한글 음절
    (cp >= 0x1100 && cp <= 0x11ff) || // 한글 자모
    (cp >= 0x3130 && cp <= 0x318f) || // 한글 호환 자모
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 통합 한자
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 기호·구두점 (전각 공백 포함)
    (cp >= 0xff00 && cp <= 0xff60) || // 전각 형태
    cp === 0x266a // ♪ (가사 표기)
  );
}

/** 초당 가중 글자 수 */
export function cpsOf(text: string, durationMs: number): number {
  if (durationMs <= 0) return Number.POSITIVE_INFINITY;
  return Math.round((weightedLength(text) / (durationMs / 1000)) * 100) / 100;
}
