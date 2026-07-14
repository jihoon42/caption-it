/**
 * 캡션잇 엔트리포인트 — 포트 바인딩만 담당.
 * 앱·MCP 서버 구성은 app.ts (demo.mjs·테스트가 기동 side-effect 없이 재사용).
 */
import { SERVICE, VERSION, createApp } from "./app.js";
import { availableProviders } from "./stt.js";

const PORT = Number(process.env.PORT ?? 8080);
createApp().listen(PORT, () => {
  console.log(`${SERVICE} MCP (v${VERSION}) listening on :${PORT}/mcp — STT: ${availableProviders().join(",")}`);
});
