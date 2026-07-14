/**
 * 캡션잇 — 결정론적 자막 엔진
 *
 * 아키텍처 원칙 (링킷과 동일):
 *   자연어 이해·요약·의역 = 클라이언트 LLM / 산술·규격 판정·형식 변환 = 서버(결정론).
 *   같은 입력에는 항상 같은 큐 분할, 같은 타임코드, 같은 위반 리포트가 나온다.
 *
 * 내용 불변 원칙:
 *   엔진은 어휘를 바꾸지 않는다. 허용되는 텍스트 변경은 표기 규칙 수준
 *   (... → …, 줄 끝 마침표·쉼표 제거, 공백 정규화)뿐이며 전부 fix_log에 남는다.
 *   CPS 위반이 표시 시간 연장으로 해결되지 않으면 서버는 축약하지 않고
 *   needs_text_reduction으로 표시해 에이전트/사람에게 판단을 넘긴다.
 */
import {
  Ruleset,
  cpsOf,
  weightedLength,
} from "./standards.js";

export interface Segment {
  start_ms: number;
  end_ms: number;
  text: string;
  speaker?: string;
  kind?: "dialogue" | "lyrics";
}

export interface Cue {
  start_ms: number;
  end_ms: number;
  lines: string[];
  speaker?: string;
  kind?: "dialogue" | "lyrics" | "sound";
}

export interface Violation {
  rule: string;
  severity: "error" | "warn" | "info";
  cue_index: number | null;
  time: string | null;
  found: string;
  limit: string;
  suggestion: string;
}

// ---------------------------------------------------------------- 유틸

const cueText = (c: Cue) => c.lines.join(" ");
const cueDur = (c: Cue) => c.end_ms - c.start_ms;

export function fmtTime(ms: number, style: "vtt" | "srt"): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const f = t % 1000;
  const pad = (n: number, len: number) => String(n).padStart(len, "0");
  const sep = style === "vtt" ? "." : ",";
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${sep}${pad(f, 3)}`;
}

function parseTime(str: string): number | null {
  const m = str.trim().match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{3})$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600000 + parseInt(m[2], 10) * 60000 + parseInt(m[3], 10) * 1000 + parseInt(m[4], 10);
}

/** 표기 정규화 — 어휘를 바꾸지 않는 수준의 교정만 수행 */
export function normalizeTypography(text: string): { text: string; changes: string[] } {
  const changes: string[] = [];
  let t = text.replace(/[ \t]+/g, " ").trim();
  if (/\.{3,}/.test(t)) {
    t = t.replace(/\.{3,}/g, "…");
    changes.push("말줄임표를 U+2026(…)으로 통일");
  }
  // 줄(큐) 끝 마침표·쉼표 제거 — 숫자 뒤 마침표(예: "3.")는 보존
  const m = t.match(/([.,]+)$/);
  if (m && !/\d[.,]+$/.test(t)) {
    t = t.slice(0, -m[1].length).trimEnd();
    changes.push("줄 끝 마침표·쉼표 제거 (Netflix I.13)");
  }
  return { text: t, changes };
}

/** VTT 큐 텍스트 이스케이프 (W3C WebVTT) */
function escapeVtt(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/-->/g, "→");
}

function unescapeVtt(text: string): string {
  return text
    .replace(/<\/?[^>]+>/g, "") // <v 화자> 등 태그 제거 (가중치 계산용)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
}

/** 문장 분리 — 종결 부호 기준. 부호가 없으면 통째로 반환 */
export function splitSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [text.trim()];
}

/** 절 분리 — 쉼표 우선, 없으면 가운데 공백. 더 못 쪼개면 [원문] */
function splitClause(text: string): string[] {
  const commas = [...text.matchAll(/,\s*/g)];
  if (commas.length) {
    const mid = text.length / 2;
    let best = commas[0];
    for (const c of commas) {
      if (Math.abs((c.index ?? 0) - mid) < Math.abs((best.index ?? 0) - mid)) best = c;
    }
    const at = (best.index ?? 0) + best[0].length;
    return [text.slice(0, at).trim(), text.slice(at).trim()].filter(Boolean);
  }
  const spaces = [...text.matchAll(/\s+/g)];
  if (spaces.length) {
    const mid = text.length / 2;
    let best = spaces[0];
    for (const c of spaces) {
      if (Math.abs((c.index ?? 0) - mid) < Math.abs((best.index ?? 0) - mid)) best = c;
    }
    const at = best.index ?? 0;
    return [text.slice(0, at).trim(), text.slice(at).trim()].filter(Boolean);
  }
  return [text];
}

/**
 * 줄바꿈 (I.11/I.13)
 *  - 한 줄에 들어가면 한 줄 유지
 *  - 2줄 분배는 유효 분할점을 전부 열거해 스코어링:
 *    ① 줄 끝 마침표·쉼표 회피(하드) ② bottom-heavy(윗줄 ≤ 아랫줄) ③ 두 줄 균형
 *  - 단일 토큰이 한 줄 한도를 넘으면 글자 단위로 강제 분할
 *  - 2줄로 담을 수 없으면 overflow=true (호출자가 큐를 나눈다 — 텍스트는 절대 버리지 않는다)
 */
const endsWithBannedPunct = (line: string) => /[.,]$/.test(line) && !/\d[.,]$/.test(line);

export function wrapLines(
  text: string,
  maxWeight: number,
  maxLines: number,
): { lines: string[]; overflow: boolean } {
  const tokens: string[] = [];
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    if (weightedLength(raw) <= maxWeight) {
      tokens.push(raw);
      continue;
    }
    let buf = "";
    for (const ch of raw) {
      if (weightedLength(buf + ch) > maxWeight) {
        tokens.push(buf);
        buf = ch;
      } else buf += ch;
    }
    if (buf) tokens.push(buf);
  }
  const joinW = (toks: string[]) => weightedLength(toks.join(" "));
  if (joinW(tokens) <= maxWeight) return { lines: [tokens.join(" ")], overflow: false };

  if (maxLines >= 2) {
    // 유효 분할점 열거 (1..n-1): 두 줄 모두 한도 이내
    let best: { lines: [string, string]; score: [number, number, number, number] } | null = null;
    for (let k = 1; k < tokens.length; k++) {
      const a = tokens.slice(0, k).join(" ");
      const b = tokens.slice(k).join(" ");
      const wa = weightedLength(a);
      const wb = weightedLength(b);
      if (wa > maxWeight || wb > maxWeight) continue;
      const score: [number, number, number, number] = [
        endsWithBannedPunct(a) ? 1 : 0, // ① 줄 끝 마침표·쉼표 (하드 회피)
        wa > wb ? 1 : 0, //               ② bottom-heavy 선호
        Math.abs(wb - wa), //             ③ 균형
        k, //                             ④ 결정성 타이브레이크
      ];
      if (
        !best ||
        score[0] < best.score[0] ||
        (score[0] === best.score[0] && score[1] < best.score[1]) ||
        (score[0] === best.score[0] && score[1] === best.score[1] && score[2] < best.score[2])
      )
        best = { lines: [a, b], score };
    }
    if (best) return { lines: best.lines, overflow: false };
  }
  // 2줄로 담을 수 없음 → 그리디로 전체 반환 (호출자가 큐 분할). 텍스트 유실 금지.
  const lines: string[] = [];
  let cur = "";
  for (const tok of tokens) {
    const cand = cur ? `${cur} ${tok}` : tok;
    if (weightedLength(cand) <= maxWeight) cur = cand;
    else {
      if (cur) lines.push(cur);
      cur = tok;
    }
  }
  if (cur) lines.push(cur);
  return { lines, overflow: lines.length > maxLines };
}

// ---------------------------------------------------------------- 큐 조립

interface Unit {
  start_ms: number;
  end_ms: number;
  text: string;
  speaker?: string;
  kind?: "dialogue" | "lyrics";
}

/** 세그먼트 → 문장 단위 분해 (시간은 가중 글자 수 비례 배분) */
function toUnits(segments: Segment[], maxCueWeight: number): Unit[] {
  const units: Unit[] = [];
  for (const seg of segments) {
    const clean = seg.text.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    let parts = splitSentences(clean);
    // 큐 총량(2줄 한도)을 넘는 문장은 절 단위로 재귀 분할
    const expand = (p: string): string[] =>
      weightedLength(p) > maxCueWeight
        ? splitClause(p).flatMap((half) => (half === p ? [p] : expand(half)))
        : [p];
    parts = parts.flatMap(expand);
    const totalW = parts.reduce((s, p) => s + weightedLength(p), 0) || 1;
    const span = Math.max(0, seg.end_ms - seg.start_ms);
    let t = seg.start_ms;
    parts.forEach((p, i) => {
      const dur = i === parts.length - 1 ? seg.end_ms - t : (span * weightedLength(p)) / totalW;
      units.push({
        start_ms: Math.round(t),
        end_ms: Math.round(t + dur),
        text: p,
        speaker: seg.speaker,
        kind: seg.kind,
      });
      t += dur;
    });
  }
  return units.sort((a, b) => a.start_ms - b.start_ms);
}

export interface BuildResult {
  cues: Cue[];
  fix_log: string[];
  violations: Violation[];
}

/**
 * 핵심 파이프라인: 세그먼트 → 규격 준수 큐
 * 병합 → 타이밍 보정 → CPS 보정(간격 차용) → 화자 라벨 → 가사 표기 → 줄바꿈
 */
export function buildCues(
  segments: Segment[],
  ruleset: Ruleset,
  opts: { speaker_labels: boolean },
): BuildResult {
  const fixLog: string[] = [];
  const maxCueWeight = ruleset.max_line_weight * ruleset.max_lines;
  const units = toUnits(segments, maxCueWeight);

  // 1) 병합 — 같은 화자·같은 종류·짧은 간격이면서 합쳐도 한도 안일 때
  const merged: Unit[] = [];
  for (const u of units) {
    const prev = merged[merged.length - 1];
    const labelHeadroom = opts.speaker_labels && u.speaker ? 4 : 0;
    if (
      prev &&
      prev.speaker === u.speaker &&
      prev.kind === u.kind &&
      u.start_ms - prev.end_ms < 1500 &&
      weightedLength(`${prev.text} ${u.text}`) <= maxCueWeight - labelHeadroom &&
      u.end_ms - prev.start_ms <= ruleset.max_duration_ms
    ) {
      prev.text = `${prev.text} ${u.text}`;
      prev.end_ms = u.end_ms;
    } else merged.push({ ...u });
  }

  const cues: Cue[] = merged.map((u) => ({
    start_ms: u.start_ms,
    end_ms: u.end_ms,
    lines: [u.text],
    speaker: u.speaker,
    kind: u.kind ?? "dialogue",
  }));

  // 2) 겹침 제거 + 최소 간격 확보 (뒤 큐가 기준)
  for (let i = 0; i < cues.length - 1; i++) {
    const limit = cues[i + 1].start_ms - ruleset.min_gap_ms;
    if (cues[i].end_ms > limit) {
      cues[i].end_ms = Math.max(cues[i].start_ms + 200, limit);
      fixLog.push(`큐 ${i + 1}: 다음 큐와의 간격 ${ruleset.min_gap_ms}ms 확보를 위해 종료 시각 조정`);
    }
  }

  // 3) 최소/최대 노출 시간
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (cueDur(c) < ruleset.min_duration_ms) {
      const nextStart = i + 1 < cues.length ? cues[i + 1].start_ms : Number.POSITIVE_INFINITY;
      c.end_ms = Math.min(c.start_ms + ruleset.min_duration_ms, nextStart - ruleset.min_gap_ms);
      if (cueDur(c) >= ruleset.min_duration_ms)
        fixLog.push(`큐 ${i + 1}: 최소 노출 ${ruleset.min_duration_ms}ms 확보 (뒤 간격 차용)`);
    }
    if (cueDur(c) > ruleset.max_duration_ms) {
      c.end_ms = c.start_ms + ruleset.max_duration_ms;
      fixLog.push(`큐 ${i + 1}: 최대 노출 ${ruleset.max_duration_ms}ms로 제한`);
    }
  }

  // 4) CPS 보정 — 표시 시간 연장만 시도. 축약은 하지 않는다.
  const violations: Violation[] = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const text = cueText(c);
    if (cpsOf(text, cueDur(c)) <= ruleset.max_cps) continue;
    const neededMs = Math.ceil((weightedLength(text) / ruleset.max_cps) * 1000);
    const nextStart = i + 1 < cues.length ? cues[i + 1].start_ms : c.end_ms + 3000;
    const extended = Math.min(c.start_ms + neededMs, nextStart - ruleset.min_gap_ms);
    if (extended > c.end_ms) {
      c.end_ms = extended;
      fixLog.push(`큐 ${i + 1}: 읽기 속도 확보를 위해 노출 연장 (${cpsOf(text, cueDur(c))} CPS)`);
    }
    if (cpsOf(text, cueDur(c)) > ruleset.max_cps) {
      violations.push({
        rule: "needs_text_reduction",
        severity: "warn",
        cue_index: i + 1,
        time: fmtTime(c.start_ms, "vtt"),
        found: `${cpsOf(text, cueDur(c))} CPS`,
        limit: `${ruleset.max_cps} CPS`,
        suggestion:
          `이 큐는 표시 시간 연장으로도 읽기 속도를 맞출 수 없습니다. ` +
          `가중 ${Math.floor((cueDur(c) / 1000) * ruleset.max_cps)}자 이내로 축약이 필요합니다. ` +
          `축약(의역)은 내용 판단이므로 서버가 하지 않습니다 — 에이전트가 사용자와 함께 줄여 주세요.`,
      });
    }
  }

  // 5) 화자 라벨(SDH) — 화자가 바뀌는 큐에만 [이름] 부착 (II.8)
  if (opts.speaker_labels && ruleset.mode === "sdh") {
    let prevSpeaker: string | undefined;
    for (const c of cues) {
      if (c.speaker && c.speaker !== prevSpeaker) {
        c.lines = [`[${c.speaker}] ${c.lines[0]}`];
      }
      if (c.speaker) prevSpeaker = c.speaker;
    }
  }

  // 6) 가사 표기 — ♪ 텍스트 ♪ (II.7)
  for (const c of cues) {
    if (c.kind === "lyrics") c.lines = [`♪ ${c.lines[0]} ♪`];
  }

  // 7) 표기 정규화 + 줄바꿈 — 2줄에 담기지 않으면 큐를 나눈다 (텍스트 유실 금지)
  const finalCues: Cue[] = [];
  cues.forEach((c, i) => {
    const norm = normalizeTypography(c.lines.join(" "));
    norm.changes.forEach((ch) => fixLog.push(`큐 ${i + 1}: ${ch}`));
    const wrapped = wrapLines(norm.text, ruleset.max_line_weight, ruleset.max_lines);
    if (!wrapped.overflow) {
      finalCues.push({ ...c, lines: wrapped.lines });
      return;
    }
    const parts = splitClause(norm.text);
    if (parts.length > 1) {
      const totalW = parts.reduce((s, p) => s + weightedLength(p), 0) || 1;
      const span = c.end_ms - c.start_ms;
      let t = c.start_ms;
      parts.forEach((p, k) => {
        const dur = k === parts.length - 1 ? c.end_ms - t : (span * weightedLength(p)) / totalW;
        finalCues.push({
          ...c,
          start_ms: Math.round(t),
          end_ms: Math.round(t + dur),
          lines: wrapLines(p, ruleset.max_line_weight, ruleset.max_lines).lines,
        });
        t += dur;
      });
      fixLog.push(`큐 ${i + 1}: ${ruleset.max_lines}줄 초과 → ${parts.length}개 큐로 분할`);
      return;
    }
    // 더 못 나누는 경우: 줄 수 초과 상태로 보존하고 위반으로 보고 (잘라내지 않는다)
    finalCues.push({ ...c, lines: wrapped.lines });
    violations.push({
      rule: "cue_overflow",
      severity: "warn",
      cue_index: i + 1,
      time: fmtTime(c.start_ms, "vtt"),
      found: `${wrapped.lines.length}줄 (${ruleset.max_lines}줄 한도 초과)`,
      limit: `${ruleset.max_lines}줄 × ${ruleset.max_line_weight}자`,
      suggestion: "세그먼트를 더 잘게 나눠 다시 호출하거나 텍스트 축약을 검토하세요.",
    });
  });

  // 8) 분할로 생긴 0-간격 정리 (최종 간격 보증)
  for (let i = 0; i < finalCues.length - 1; i++) {
    const limit = finalCues[i + 1].start_ms - ruleset.min_gap_ms;
    if (finalCues[i].end_ms > limit)
      finalCues[i].end_ms = Math.max(finalCues[i].start_ms + 200, limit);
  }

  return { cues: finalCues, fix_log: fixLog, violations };
}

// ---------------------------------------------------------------- 효과음 삽입

export interface SoundEvent {
  at_ms: number;
  label: string;
  kind?: "sound" | "music";
}

export function insertSoundEvents(
  cues: Cue[],
  events: SoundEvent[],
  ruleset: Ruleset,
): { placed: number; unplaced: { event: SoundEvent; reason: string }[]; log: string[] } {
  const unplaced: { event: SoundEvent; reason: string }[] = [];
  const log: string[] = [];
  let placed = 0;
  const sorted = [...events].sort((a, b) => a.at_ms - b.at_ms);

  for (const ev of sorted) {
    const label = `[${ev.label.trim()}]`;
    if (weightedLength(label) > ruleset.max_line_weight) {
      unplaced.push({ event: ev, reason: `라벨이 한 줄 한도(${ruleset.max_line_weight}자)를 넘습니다` });
      continue;
    }
    // 1순위: at_ms 주변 ±5초 내의 큐 사이 간격에 독립 큐로 삽입
    let done = false;
    const slots: { start: number; end: number }[] = [];
    if (cues.length === 0) slots.push({ start: ev.at_ms, end: ev.at_ms + 1500 });
    else {
      slots.push({ start: Math.max(0, cues[0].start_ms - 5000), end: cues[0].start_ms - ruleset.min_gap_ms });
      for (let i = 0; i < cues.length - 1; i++)
        slots.push({ start: cues[i].end_ms + ruleset.min_gap_ms, end: cues[i + 1].start_ms - ruleset.min_gap_ms });
      slots.push({ start: cues[cues.length - 1].end_ms + ruleset.min_gap_ms, end: cues[cues.length - 1].end_ms + 5000 });
    }
    for (const slot of slots) {
      const width = slot.end - slot.start;
      if (width < 700) continue;
      if (ev.at_ms < slot.start - 5000 || ev.at_ms > slot.end + 5000) continue;
      const start = Math.min(Math.max(ev.at_ms, slot.start), slot.end - 700);
      const end = Math.min(start + 1500, slot.end);
      const cue: Cue = { start_ms: Math.round(start), end_ms: Math.round(end), lines: [label], kind: "sound" };
      const at = cues.findIndex((c) => c.start_ms > cue.start_ms);
      if (at === -1) cues.push(cue);
      else cues.splice(at, 0, cue);
      log.push(`효과음 ${label}: ${fmtTime(cue.start_ms, "vtt")}에 독립 큐로 삽입`);
      placed++;
      done = true;
      break;
    }
    if (done) continue;
    // 2순위: at_ms를 덮는 1줄 큐에 이중 표기(- 대사 / - [효과음])로 부착 (II.5)
    const host = cues.find(
      (c) => c.kind !== "sound" && c.start_ms <= ev.at_ms && ev.at_ms <= c.end_ms && c.lines.length === 1,
    );
    if (
      host &&
      weightedLength(`- ${host.lines[0]}`) <= ruleset.max_line_weight &&
      weightedLength(`- ${label}`) <= ruleset.max_line_weight
    ) {
      host.lines = [`- ${host.lines[0]}`, `- ${label}`];
      log.push(`효과음 ${label}: 겹치는 큐에 이중 표기로 부착`);
      placed++;
      continue;
    }
    unplaced.push({ event: ev, reason: "주변에 충분한 간격이 없고 겹치는 큐에도 부착할 수 없습니다" });
  }
  return { placed, unplaced, log };
}

// ---------------------------------------------------------------- 직렬화

export function emitVtt(cues: Cue[]): string {
  const body = cues
    .map(
      (c) =>
        `${fmtTime(c.start_ms, "vtt")} --> ${fmtTime(c.end_ms, "vtt")}\n` +
        c.lines.map(escapeVtt).join("\n"),
    )
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

export function emitSrt(cues: Cue[]): string {
  return (
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${fmtTime(c.start_ms, "srt")} --> ${fmtTime(c.end_ms, "srt")}\n${c.lines.join("\n")}`,
      )
      .join("\n\n") + "\n"
  );
}

// ---------------------------------------------------------------- 파싱

export interface ParseResult {
  format: "vtt" | "srt" | "unknown";
  cues: Cue[];
  syntax_errors: string[];
}

export function parseCaptions(input: string): ParseResult {
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  const errors: string[] = [];
  const isVtt = /^WEBVTT/.test(text);
  const blocks = (isVtt ? text.replace(/^WEBVTT[^\n]*\n?/, "") : text)
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  const cues: Cue[] = [];

  for (const block of blocks) {
    if (isVtt && /^(NOTE|STYLE|REGION)\b/.test(block)) continue;
    const lines = block.split("\n");
    let timeLineIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeLineIdx === -1) {
      errors.push(`타임라인 없는 블록 무시: "${lines[0]?.slice(0, 40)}"`);
      continue;
    }
    const tl = lines[timeLineIdx];
    const [rawStart, rawRest] = tl.split("-->");
    const rawEnd = (rawRest ?? "").trim().split(/\s+/)[0]; // 큐 세팅 제거
    const start = parseTime(rawStart ?? "");
    const end = parseTime(rawEnd ?? "");
    if (start === null || end === null) {
      errors.push(`타임스탬프 해석 실패: "${tl.slice(0, 60)}"`);
      continue;
    }
    const body = lines
      .slice(timeLineIdx + 1)
      .map((l) => (isVtt ? unescapeVtt(l) : l).trim())
      .filter(Boolean);
    cues.push({ start_ms: start, end_ms: end, lines: body });
  }
  cues.sort((a, b) => a.start_ms - b.start_ms);
  return { format: isVtt ? "vtt" : cues.length ? "srt" : "unknown", cues, syntax_errors: errors };
}

// ---------------------------------------------------------------- 감사

export function auditCues(cues: Cue[], ruleset: Ruleset): Violation[] {
  const out: Violation[] = [];
  const push = (
    rule: string,
    severity: Violation["severity"],
    i: number | null,
    found: string,
    limit: string,
    suggestion: string,
  ) =>
    out.push({
      rule,
      severity,
      cue_index: i === null ? null : i + 1,
      time: i === null ? null : fmtTime(cues[i].start_ms, "vtt"),
      found,
      limit,
      suggestion,
    });

  cues.forEach((c, i) => {
    const text = cueText(c);
    const dur = cueDur(c);
    if (!text.trim()) push("empty_cue", "error", i, "빈 큐", "내용 필수", "빈 큐를 제거하세요.");
    if (dur <= 0)
      push("non_positive_duration", "error", i, `${dur}ms`, "> 0ms", "종료 시각이 시작 시각보다 커야 합니다.");
    if (dur > 0 && cpsOf(text, dur) > ruleset.max_cps)
      push(
        "cps_exceeded", "error", i,
        `${cpsOf(text, dur)} CPS`, `≤ ${ruleset.max_cps} CPS`,
        "노출 시간을 늘리거나(간격 차용) 텍스트 축약을 검토하세요. 자동 보정은 시간 연장까지만 수행합니다.",
      );
    c.lines.forEach((l) => {
      if (weightedLength(l) > ruleset.max_line_weight)
        push(
          "line_too_long", "error", i,
          `${weightedLength(l)}자 ("${l.slice(0, 20)}…")`, `≤ ${ruleset.max_line_weight}자(가중)`,
          "자동 보정이 줄을 다시 감쌉니다.",
        );
      if (/[.,]$/.test(l) && !/\d[.,]$/.test(l))
        push("trailing_punct", "warn", i, `"…${l.slice(-6)}"`, "줄 끝 마침표·쉼표 금지", "자동 보정이 제거합니다 (Netflix I.13).");
    });
    if (c.lines.length > ruleset.max_lines)
      push("too_many_lines", "error", i, `${c.lines.length}줄`, `≤ ${ruleset.max_lines}줄`, "자동 보정이 다시 감싸거나 큐를 나눕니다.");
    if (dur > 0 && dur < ruleset.min_duration_ms)
      push("duration_too_short", "warn", i, `${dur}ms`, `≥ ${ruleset.min_duration_ms}ms`, "자동 보정이 뒤 간격에서 시간을 차용합니다.");
    if (dur > ruleset.max_duration_ms)
      push("duration_too_long", "warn", i, `${dur}ms`, `≤ ${ruleset.max_duration_ms}ms`, "자동 보정이 문장 경계에서 큐를 나눕니다.");
    if (/\.{3,}/.test(text))
      push("ascii_ellipsis", "info", i, '"..."', "U+2026(…) 사용", "자동 보정이 통일합니다 (Netflix I.4).");
    if ((text.match(/♪/g) ?? []).length % 2 === 1)
      push("unpaired_music_note", "warn", i, "♪ 홀수 개", "가사는 ♪ … ♪ 쌍", "가사 큐는 양 끝에 ♪를 붙이세요 (II.7).");
    if (i < cues.length - 1) {
      const gap = cues[i + 1].start_ms - c.end_ms;
      if (gap < 0)
        push("overlap", "error", i, `${-gap}ms 겹침`, "겹침 금지", "자동 보정이 앞 큐 종료를 당깁니다.");
      else if (gap < ruleset.min_gap_ms)
        push("gap_too_small", "warn", i, `${gap}ms`, `≥ ${ruleset.min_gap_ms}ms`, "자동 보정이 간격을 확보합니다.");
    }
  });

  if (ruleset.mode === "sdh" && cues.length > 0) {
    const hasBrackets = cues.some((c) => /\[[^\]]+\]/.test(cueText(c)));
    if (!hasBrackets)
      push(
        "sdh_signals_missing", "info", null,
        "화자 표시·소리 정보 [ ] 없음", "SDH는 화자·소리 정보 권장",
        "화자가 화면만으로 식별되지 않는 지점에 [이름]을, 줄거리에 중요한 소리에 [효과음]을 추가하는 것을 검토하세요 (II.8/II.9). 어떤 소리가 중요한지는 내용 판단이므로 자동 추가하지 않습니다.",
      );
  }
  return out;
}

// ---------------------------------------------------------------- 자동 보정

export interface FixResult {
  cues: Cue[];
  fix_log: string[];
  unresolved: Violation[];
}

/** 내용 불변 자동 보정: 표기·줄바꿈·타이밍만 손댄다 */
export function autofixCues(cuesIn: Cue[], ruleset: Ruleset): FixResult {
  const fixLog: string[] = [];
  let cues: Cue[] = cuesIn
    .filter((c) => cueText(c).trim().length > 0)
    .map((c) => ({ ...c, lines: [...c.lines] }))
    .sort((a, b) => a.start_ms - b.start_ms);
  if (cues.length !== cuesIn.length) fixLog.push(`빈 큐 ${cuesIn.length - cues.length}개 제거`);

  // 1) 표기 정규화 + 재줄바꿈
  cues.forEach((c, i) => {
    const norm = normalizeTypography(c.lines.join(" "));
    norm.changes.forEach((ch) => fixLog.push(`큐 ${i + 1}: ${ch}`));
    const wrapped = wrapLines(norm.text, ruleset.max_line_weight, ruleset.max_lines);
    if (wrapped.overflow) {
      // 2줄 초과 → 문장 경계에서 큐 분할 (시간은 가중치 비례)
      const parts = splitSentences(norm.text).flatMap((p) =>
        weightedLength(p) > ruleset.max_line_weight * ruleset.max_lines ? splitClause(p) : [p],
      );
      if (parts.length > 1) {
        const totalW = parts.reduce((s, p) => s + weightedLength(p), 0) || 1;
        const span = cueDur(c);
        let t = c.start_ms;
        const replacement: Cue[] = parts.map((p, k) => {
          const dur = k === parts.length - 1 ? c.end_ms - t : (span * weightedLength(p)) / totalW;
          const nc: Cue = {
            start_ms: Math.round(t),
            end_ms: Math.round(t + dur),
            lines: wrapLines(p, ruleset.max_line_weight, ruleset.max_lines).lines,
            speaker: c.speaker,
            kind: c.kind,
          };
          t += dur;
          return nc;
        });
        cues.splice(i, 1, ...replacement);
        fixLog.push(`큐 ${i + 1}: ${ruleset.max_lines}줄 초과 → ${replacement.length}개 큐로 분할`);
        return;
      }
    }
    c.lines = wrapped.lines;
  });
  cues.sort((a, b) => a.start_ms - b.start_ms);

  // 2) 겹침·간격
  for (let i = 0; i < cues.length - 1; i++) {
    const limit = cues[i + 1].start_ms - ruleset.min_gap_ms;
    if (cues[i].end_ms > limit) {
      cues[i].end_ms = Math.max(cues[i].start_ms + 200, limit);
      fixLog.push(`큐 ${i + 1}: 겹침/간격 보정`);
    }
  }

  // 3) 최소·최대 노출
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (cueDur(c) < ruleset.min_duration_ms) {
      const nextStart = i + 1 < cues.length ? cues[i + 1].start_ms : Number.POSITIVE_INFINITY;
      const target = Math.min(c.start_ms + ruleset.min_duration_ms, nextStart - ruleset.min_gap_ms);
      if (target > c.end_ms) {
        c.end_ms = target;
        fixLog.push(`큐 ${i + 1}: 최소 노출 확보`);
      }
    }
    if (cueDur(c) > ruleset.max_duration_ms) {
      c.end_ms = c.start_ms + ruleset.max_duration_ms;
      fixLog.push(`큐 ${i + 1}: 최대 노출 제한`);
    }
  }

  // 4) CPS — 간격 차용으로 연장 (축약은 하지 않음)
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const text = cueText(c);
    if (cpsOf(text, cueDur(c)) <= ruleset.max_cps) continue;
    const neededMs = Math.ceil((weightedLength(text) / ruleset.max_cps) * 1000);
    const nextStart = i + 1 < cues.length ? cues[i + 1].start_ms : c.end_ms + 3000;
    const extended = Math.min(c.start_ms + neededMs, nextStart - ruleset.min_gap_ms);
    if (extended > c.end_ms) {
      c.end_ms = extended;
      fixLog.push(`큐 ${i + 1}: 읽기 속도 확보를 위해 노출 연장`);
    }
  }

  const unresolved = auditCues(cues, ruleset).filter((v) => v.severity === "error");
  return { cues, fix_log: fixLog, unresolved };
}

// ---------------------------------------------------------------- 통계

export function cueStats(cues: Cue[], ruleset: Ruleset) {
  const dialogue = cues.filter((c) => cueText(c).trim());
  const cpsValues = dialogue
    .map((c) => cpsOf(cueText(c), cueDur(c)))
    .filter((v) => Number.isFinite(v));
  const avg = cpsValues.length
    ? Math.round((cpsValues.reduce((a, b) => a + b, 0) / cpsValues.length) * 100) / 100
    : 0;
  return {
    cue_count: cues.length,
    total_duration_ms: cues.length ? cues[cues.length - 1].end_ms - cues[0].start_ms : 0,
    avg_cps: avg,
    max_cps: cpsValues.length ? Math.max(...cpsValues) : 0,
    cps_limit: ruleset.max_cps,
    ruleset_id: ruleset.id,
  };
}
