/**
 * 캡션잇 — 내장 합성 샘플 (전원 가상 콘텐츠)
 *
 * 목적: STT 키·외부 URL 없이도 전사→자막 파이프라인 전체를 체험할 수 있게 한다.
 * 링킷의 데모 프로필 3종과 같은 설계 원칙: 실존 인물·실제 회의가 아니며 항상 is_demo 고지.
 */
import { Segment } from "./engine.js";

export interface SampleMedia {
  id: string;
  title: string;
  description: string;
  language: string;
  duration_ms: number;
  segments: Segment[];
  /** build_accessible_captions의 sound_events 파라미터 체험용 제안 값 */
  suggested_sound_events?: { at_ms: number; label: string }[];
  is_demo: true;
}

export const SAMPLE_NOTICE =
  "이 샘플은 체험용 합성(가상) 콘텐츠입니다. 실제 회의·강의 녹음이 아니며, " +
  "등장하는 호칭·내용은 모두 가상입니다. 실제 사용 시에는 transcribe_media에 오디오 URL을 전달하세요.";

export const SAMPLES: SampleMedia[] = [
  {
    id: "demo_meeting",
    title: "주간 회의 발췌 (가상, 2인, 78초)",
    description:
      "진행자·발표자 2인의 회의 전사. 화자 라벨, 짧은 응답 병합, 읽기 속도 보정을 체험할 수 있습니다.",
    language: "ko-KR",
    duration_ms: 78000,
    is_demo: true,
    suggested_sound_events: [{ at_ms: 77000, label: "박수" }],
    segments: [
      { start_ms: 0, end_ms: 4200, text: "자, 그럼 주간 회의 시작하겠습니다.", speaker: "진행자" },
      { start_ms: 4400, end_ms: 9800, text: "오늘 안건은 세 가지인데요, 먼저 지난주 배포 결과부터 보겠습니다.", speaker: "진행자" },
      { start_ms: 10200, end_ms: 16800, text: "지난주 금요일에 배포한 검색 개선 건은 오류 없이 안정적으로 운영되고 있습니다.", speaker: "발표자" },
      { start_ms: 17000, end_ms: 24500, text: "다만 모바일에서 응답이 평소보다 느리다는 문의가 두 건 있었고, 원인은 이미지 캐시 설정으로 확인됐습니다.", speaker: "발표자" },
      { start_ms: 25000, end_ms: 28000, text: "수정 배포는 언제 가능할까요?", speaker: "진행자" },
      { start_ms: 28300, end_ms: 33200, text: "내일 오전 중으로 가능합니다. 테스트는 오늘 밤에 끝내겠습니다.", speaker: "발표자" },
      { start_ms: 33800, end_ms: 40000, text: "좋습니다. 두 번째 안건은 다음 달 워크숍 일정입니다.", speaker: "진행자" },
      { start_ms: 40200, end_ms: 47500, text: "장소는 작년과 같은 연수원으로 예약했고, 세부 일정은 이번 주 안에 공지로 올리겠습니다.", speaker: "진행자" },
      { start_ms: 48000, end_ms: 54000, text: "공지 올리실 때 지도랑 교통편도 같이 부탁드립니다. 작년에 헷갈렸다는 분들이 많았어요.", speaker: "발표자" },
      { start_ms: 54300, end_ms: 56000, text: "네, 반영하겠습니다.", speaker: "진행자" },
      { start_ms: 56500, end_ms: 64000, text: "마지막으로, 회의록은 오늘부터 회의 직후에 바로 공유하는 걸로 바꾸겠습니다.", speaker: "진행자" },
      { start_ms: 64500, end_ms: 70000, text: "그럼 자료는 회의 전날까지 올리는 걸로 정리하면 될까요?", speaker: "발표자" },
      { start_ms: 70300, end_ms: 76500, text: "맞습니다. 전날 오후 다섯 시까지 부탁드립니다. 다른 의견 없으시면 오늘은 여기까지 하겠습니다.", speaker: "진행자" },
    ],
  },
  {
    id: "demo_lecture",
    title: "접근성 강의 발췌 (가상, 1인, 28초)",
    description:
      "긴 문장이 많은 단일 화자 강의. 절 단위 분할과 노출 시간 연장(CPS 보정)을 체험할 수 있습니다.",
    language: "ko-KR",
    duration_ms: 28000,
    is_demo: true,
    segments: [
      { start_ms: 0, end_ms: 9500, text: "오늘 다룰 주제는 웹 접근성인데, 접근성은 특정한 사람들을 위한 배려가 아니라 모든 사용자의 경험을 넓히는 기본 설계 원칙입니다.", speaker: "강사" },
      { start_ms: 9800, end_ms: 15200, text: "예를 들어 영상에 자막을 붙이면 소리를 들을 수 없는 사람만 좋은 게 아닙니다.", speaker: "강사" },
      { start_ms: 15500, end_ms: 23000, text: "지하철에서 소리를 켜지 않고 영상을 보는 사람, 한국어를 배우는 유학생, 회의 내용을 다시 확인하는 동료까지 모두가 같은 자막의 수혜자가 됩니다.", speaker: "강사" },
      { start_ms: 23300, end_ms: 27000, text: "그래서 접근성 투자는 소수를 위한 비용이 아니라 전체를 위한 품질입니다.", speaker: "강사" },
    ],
  },
];

export function getSample(id: string): SampleMedia | undefined {
  return SAMPLES.find((s) => s.id === id);
}
