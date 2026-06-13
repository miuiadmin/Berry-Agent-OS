/**
 * 真实 AI 对话烟雾测试 — 通过 WebSocket 向后端发消息，验证全链路。
 *
 * 用法：npx tsx tools/real-chat-smoke.ts [--verbose]
 * 前置：后端已启动（npm run dev:debug 或 berry service start --foreground --debug）
 */
import WebSocket from "ws";

const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
const sid = "real-test-" + Date.now();
const ws = new WebSocket(`ws://localhost:3888/ws?sessionId=${sid}`);

let streamed = 0;
let msgCount = 0;

const timer = setTimeout(() => {
  console.error(`\n⏰ 超时（120s，共收到 ${msgCount} 条消息）`);
  ws.close();
  process.exit(1);
}, 120_000);

ws.on("open", () => {
  console.log("🔌 WS 已连接");
  // 订阅本会话的流式事件（result / text_delta 等按 sessionId 过滤派发）
  ws.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
  console.log("📤 已订阅会话，发送消息...");
  ws.send(JSON.stringify({
    type: "message",
    text: "你好，请用一句话介绍你自己",
    sessionId: sid,
    permissionMode: "allow-all",
  }));
});

// WS 协议：每帧 = 一条完整 JSON 消息（与前端 ws-store.ts 一致，不按 \n 分割）
ws.on("message", (raw) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    if (verbose) console.log(`[parse fail] ${raw.toString().slice(0, 200)}`);
    return;
  }
  msgCount++;
  const type = msg.type as string;

  if (verbose) {
    const preview = JSON.stringify(msg).slice(0, 300);
    console.log(`[msg #${msgCount}] type=${type} ${preview}`);
  }

  switch (type) {
    case "text_delta": {
      const delta = (msg.text as string) || (msg.delta as string) || "";
      streamed += delta.length;
      process.stdout.write(delta);
      break;
    }
    case "result": {
      clearTimeout(timer);
      const response = (msg.response as string) || "";
      console.log(`\n\n✅ AI 回复完成（流式 ${streamed} 字符 / 最终 ${response.length} 字符）`);
      console.log(`sessionId: ${msg.sessionId ?? sid}`);
      ws.close();
      process.exit(0);
    }
    case "no_response": {
      clearTimeout(timer);
      console.error("\n⚠️ no_response");
      ws.close();
      process.exit(1);
    }
    case "error": {
      clearTimeout(timer);
      console.error("\n❌ 错误:", msg.error);
      ws.close();
      process.exit(1);
    }
    default:
      break;
  }
});

ws.on("error", (err) => {
  clearTimeout(timer);
  console.error("❌ WS 错误:", err.message);
  process.exit(1);
});
