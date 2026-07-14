/**
 * 캡션잇 — STT 프로바이더 어댑터
 *
 * 설계:
 *  - 프로바이더는 환경 변수로 켜진다. 키가 없으면 그 프로바이더는 "없음"이며,
 *    서버는 조용히 대체하지 않고 어떤 env가 필요한지 구조화된 안내를 반환한다.
 *  - 모든 프로바이더 출력은 동일한 Segment 형식(start_ms/end_ms/text/speaker?)으로
 *    정규화된다 → build_accessible_captions에 그대로 전달 가능.
 *  - mock 프로바이더는 내장 합성 샘플을 반환한다 (외부 의존 0, 데모 안정성 담보).
 *
 * env:
 *  - STT_PROVIDER                 기본 프로바이더 (clova | azure | openai | mock)
 *  - CLOVA_SPEECH_INVOKE_URL      CLOVA Speech 도메인 Invoke URL
 *  - CLOVA_SPEECH_SECRET          CLOVA Speech Secret Key
 *  - AZURE_SPEECH_KEY             Azure Speech 리소스 키
 *  - AZURE_SPEECH_ENDPOINT        예: https://koreacentral.api.cognitive.microsoft.com
 *  - AZURE_SPEECH_API_VERSION     기본 2025-10-15 (fast transcription 현행 문서 기준)
 *  - OPENAI_API_KEY               OpenAI API 키
 *  - OPENAI_STT_MODEL             기본 whisper-1 (segment 타임스탬프는 whisper-1만 보장)
 */
import { Segment } from "./engine.js";
import { getSample } from "./samples.js";

export type ProviderName = "clova" | "azure" | "openai" | "mock";

export interface SttResult {
  provider: ProviderName;
  language: string;
  duration_ms?: number;
  segments: Segment[];
  full_text: string;
  warnings: string[];
  is_demo?: boolean;
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25MB (OpenAI 상한과 동일하게 통일)
const FETCH_TIMEOUT_MS = 90_000;

export function availableProviders(): ProviderName[] {
  const out: ProviderName[] = [];
  if (process.env.CLOVA_SPEECH_INVOKE_URL && process.env.CLOVA_SPEECH_SECRET) out.push("clova");
  if (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_ENDPOINT) out.push("azure");
  if (process.env.OPENAI_API_KEY) out.push("openai");
  out.push("mock");
  return out;
}

export function providerSetupGuide() {
  return {
    clova: {
      env: ["CLOVA_SPEECH_INVOKE_URL", "CLOVA_SPEECH_SECRET"],
      note: "네이버클라우드 CLOVA Speech 도메인 생성 후 Invoke URL·Secret 발급. 한국어 인식·화자 분리 지원.",
    },
    azure: {
      env: ["AZURE_SPEECH_KEY", "AZURE_SPEECH_ENDPOINT"],
      note: "Azure Speech 리소스(fast transcription, ko-KR 지원). 학생/무료 티어 사용 가능 여부는 구독에 따름.",
    },
    openai: {
      env: ["OPENAI_API_KEY"],
      note: "whisper-1이 segment 타임스탬프를 반환. 파일 25MB 이하.",
    },
    mock: { env: [], note: "내장 합성 샘플 전사 반환 (키 불필요, 데모용)." },
  };
}

function normalizeLanguage(lang: string, provider: ProviderName): string {
  const lower = lang.toLowerCase();
  const base = lower.split("-")[0];
  if (provider === "openai") return base; // ISO-639-1
  if (base === "ko") return "ko-KR";
  if (base === "en") return "en-US";
  if (base === "ja") return "ja-JP";
  return lang;
}

async function downloadAudio(url: string): Promise<{ blob: Blob; contentType: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`오디오 URL 응답 오류: HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_AUDIO_BYTES) throw new Error(`오디오가 25MB를 초과합니다 (${len} bytes)`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_AUDIO_BYTES) throw new Error(`오디오가 25MB를 초과합니다 (${buf.byteLength} bytes)`);
    return {
      blob: new Blob([buf], { type: res.headers.get("content-type") ?? "application/octet-stream" }),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- CLOVA

async function clovaTranscribe(url: string, language: string, diarization: boolean): Promise<SttResult> {
  const invokeUrl = process.env.CLOVA_SPEECH_INVOKE_URL as string;
  const res = await fetch(`${invokeUrl.replace(/\/$/, "")}/recognizer/url`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CLOVASPEECH-API-KEY": process.env.CLOVA_SPEECH_SECRET as string,
    },
    body: JSON.stringify({
      url,
      language,
      completion: "sync",
      fullText: true,
      wordAlignment: false,
      diarization: { enable: diarization },
    }),
  });
  const data = (await res.json()) as {
    result?: string;
    message?: string;
    text?: string;
    segments?: { start: number; end: number; text: string; speaker?: { label?: string } }[];
  };
  if (!res.ok || (data.result && data.result !== "COMPLETED")) {
    throw new Error(`CLOVA Speech 오류: ${data.message ?? data.result ?? res.status}`);
  }
  const segments: Segment[] = (data.segments ?? []).map((s) => ({
    start_ms: s.start,
    end_ms: s.end,
    text: s.text.trim(),
    speaker: diarization && s.speaker?.label ? `화자${s.speaker.label}` : undefined,
  }));
  return {
    provider: "clova",
    language,
    segments,
    full_text: data.text ?? segments.map((s) => s.text).join(" "),
    duration_ms: segments.length ? segments[segments.length - 1].end_ms : undefined,
    warnings: [],
  };
}

// ---------------------------------------------------------------- Azure

async function azureTranscribe(url: string, language: string, diarization: boolean): Promise<SttResult> {
  const endpoint = (process.env.AZURE_SPEECH_ENDPOINT as string).replace(/\/$/, "");
  const apiVersion = process.env.AZURE_SPEECH_API_VERSION ?? "2025-10-15";
  const { blob } = await downloadAudio(url);
  const definition: Record<string, unknown> = { locales: [language] };
  if (diarization) definition.diarization = { maxSpeakers: 4, enabled: true };
  const form = new FormData();
  form.append("audio", blob, "audio");
  form.append("definition", JSON.stringify(definition));
  const res = await fetch(
    `${endpoint}/speechtotext/transcriptions:transcribe?api-version=${apiVersion}`,
    {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY as string },
      body: form,
    },
  );
  if (!res.ok) throw new Error(`Azure Speech 오류: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    durationMilliseconds?: number;
    combinedPhrases?: { text: string }[];
    phrases?: { offsetMilliseconds: number; durationMilliseconds: number; text: string; speaker?: number }[];
  };
  const segments: Segment[] = (data.phrases ?? []).map((p) => ({
    start_ms: p.offsetMilliseconds,
    end_ms: p.offsetMilliseconds + p.durationMilliseconds,
    text: p.text.trim(),
    speaker: diarization && p.speaker !== undefined ? `화자${p.speaker}` : undefined,
  }));
  return {
    provider: "azure",
    language,
    duration_ms: data.durationMilliseconds,
    segments,
    full_text: data.combinedPhrases?.[0]?.text ?? segments.map((s) => s.text).join(" "),
    warnings: [],
  };
}

// ---------------------------------------------------------------- OpenAI

async function openaiTranscribe(url: string, language: string): Promise<SttResult> {
  const model = process.env.OPENAI_STT_MODEL ?? "whisper-1";
  const { blob } = await downloadAudio(url);
  const name = new URL(url).pathname.split("/").pop() || "audio.mp3";
  const form = new FormData();
  form.append("file", blob, name);
  form.append("model", model);
  form.append("language", language);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`OpenAI STT 오류: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    text?: string;
    duration?: number;
    segments?: { start: number; end: number; text: string }[];
  };
  const warnings: string[] = [];
  if (!data.segments?.length)
    warnings.push("이 모델은 segment 타임스탬프를 반환하지 않았습니다. whisper-1 사용을 권장합니다.");
  const segments: Segment[] = (data.segments ?? []).map((s) => ({
    start_ms: Math.round(s.start * 1000),
    end_ms: Math.round(s.end * 1000),
    text: s.text.trim(),
  }));
  return {
    provider: "openai",
    language,
    duration_ms: data.duration ? Math.round(data.duration * 1000) : undefined,
    segments,
    full_text: data.text ?? segments.map((s) => s.text).join(" "),
    warnings,
  };
}

// ---------------------------------------------------------------- 진입점

export async function transcribe(input: {
  audio_url?: string;
  sample_id?: string;
  language: string;
  diarization: boolean;
  provider?: ProviderName;
}): Promise<SttResult> {
  // 샘플 경로: 키·네트워크 불필요 (mock)
  if (input.sample_id) {
    const sample = getSample(input.sample_id);
    if (!sample) throw new Error(`알 수 없는 sample_id: ${input.sample_id}. list_sample_media로 확인하세요.`);
    return {
      provider: "mock",
      language: sample.language,
      duration_ms: sample.duration_ms,
      segments: sample.segments,
      full_text: sample.segments.map((s) => s.text).join(" "),
      warnings: [],
      is_demo: true,
    };
  }
  if (!input.audio_url) throw new Error("audio_url 또는 sample_id 중 하나는 필요합니다.");

  const avail = availableProviders();
  const chosen: ProviderName | undefined =
    input.provider ??
    (process.env.STT_PROVIDER as ProviderName | undefined) ??
    avail.find((p) => p !== "mock");

  if (!chosen || chosen === "mock" || !avail.includes(chosen)) {
    const guide = providerSetupGuide();
    throw new Error(
      JSON.stringify({
        error:
          chosen && chosen !== "mock"
            ? `프로바이더 '${chosen}'의 자격 증명이 설정되어 있지 않습니다.`
            : "실제 오디오를 전사할 STT 프로바이더가 설정되어 있지 않습니다.",
        available_now: avail,
        how_to_enable: guide,
        alternatives:
          "1) sample_id로 내장 샘플 전사를 체험하거나, 2) 이미 전사된 텍스트가 있다면 build_accessible_captions에 segments 또는 plain_text로 직접 전달하세요.",
      }),
    );
  }
  const lang = normalizeLanguage(input.language, chosen);
  if (chosen === "clova") return clovaTranscribe(input.audio_url, lang, input.diarization);
  if (chosen === "azure") return azureTranscribe(input.audio_url, lang, input.diarization);
  return openaiTranscribe(input.audio_url, lang);
}
