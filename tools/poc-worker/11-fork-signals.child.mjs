/**
 * PoC ⑪ 子侧：按 argv[2] 模式自扮三景。
 * good   —— SIGTERM handler：打告别行，模拟收尾 flush（50ms）后自然退；
 * stubborn—— SIGTERM handler 空挂（吞信号不退——逼父升级）；
 * pm     —— 与 good 同款，但由父以 --permission 沙箱旗拉起（PM 是否拦信号由本景实证）。
 */
const mode = process.argv[2];

console.log('READY');

if (mode === 'good' || mode === 'pm') {
  process.on('SIGTERM', () => {
    // 告别行先落 stdout（pipe 缓冲即时冲给父），再模拟一段收尾工作后自然退
    console.log('FAREWELL');
    setTimeout(() => process.exit(0), 50);
  });
} else if (mode === 'stubborn') {
  // 吞信号：handler 挂着但什么都不做——只有 SIGKILL 能收
  process.on('SIGTERM', () => {});
}

// 挂住事件循环（长活——等信号）
setInterval(() => {}, 1000);
