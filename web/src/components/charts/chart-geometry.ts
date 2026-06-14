/**
 * 图表几何计算 + 共享常量（纯函数模块，无 React 依赖）。
 *
 * 抽象出 AreaChart / BarChart / Sparkline 三个组件共用的数学逻辑：
 *  - 坐标系映射（数据值 → SVG 像素坐标）
 *  - 平滑曲线 path 构建（贝塞尔）+ 区域闭合 path
 *  - Y 轴刻度生成、X 轴标签采样
 *  - 配色 / 内边距 / 默认尺寸常量
 *
 * 设计目标：组件层只负责"声明渲染什么"，几何算法可独立单测，避免三处各自维护
 * 近乎相同的贝塞尔曲线和归一化代码（重构前 area-chart 与 sparkline 各写一份）。
 *
 * 坐标系约定：
 *  - SVG 原点在左上角，y 向下为正
 *  - 所有数值先归一化到 [0, 1] 再乘以绘图区尺寸，再加 padding 偏移
 *  - 因此 maxVal 至少为 1（防除零）、range 至少为 1（防零除归一化）
 */

/* ============================================================
 * 类型
 * ========================================================== */

/** 图表数据点（带标签，AreaChart / BarChart 用） */
export interface DataPoint {
  /** X 轴标签（时间 / 类目） */
  label: string;
  /** 数值（决定 Y 坐标 / 柱长） */
  value: number;
}

/** SVG 内边距（与 CSS padding 同语义，但单位是 viewBox 坐标） */
export interface ChartPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** 一个 2D 点（SVG 坐标系，单位 px） */
export interface Point {
  x: number;
  y: number;
}

/* ============================================================
 * 常量
 * ========================================================== */

/** AreaChart 的默认 viewBox 宽度（高度由调用方传入，保持纵横比自适应） */
export const SVG_WIDTH = 400;

/** AreaChart 默认高度（px） */
export const AREA_CHART_DEFAULT_HEIGHT = 160;

/** AreaChart 默认内边距（top 给 tooltip 圆点 / 顶部刻度留位，bottom 给 X 轴标签） */
export const AREA_CHART_PADDING: ChartPadding = { top: 20, right: 12, bottom: 28, left: 36 };

/** AreaChart 默认 Y 轴刻度数（含 0 和 maxVal 两个端点） */
export const AREA_CHART_Y_TICK_COUNT = 4;

/** AreaChart X 轴最多显示的标签数（超过则均匀采样避免拥挤） */
export const AREA_CHART_X_LABEL_MAX = 7;

/** Sparkline 默认尺寸（极小，常嵌在卡片角落） */
export const SPARKLINE_DEFAULT_WIDTH = 80;
export const SPARKLINE_DEFAULT_HEIGHT = 24;

/** Sparkline 四周留白（让曲线不贴 SVG 边缘，避免被裁剪） */
export const SPARKLINE_PAD = 2;

/** 图表默认色板（CSS 变量，配合 tailwind.config 的 chart-1~5） */
export const CHART_COLOR_1 = "var(--chart-1)";
/** 对比线 / 失败数默认色（语义色 destructive） */
export const CHART_COLOR_DESTRUCTIVE = "var(--destructive)";

/** 主线描边宽度（AreaChart） */
export const AREA_STROKE_PRIMARY = 2;
/** 次线描边宽度（AreaChart 第二条对比线，更细以体现主次） */
export const AREA_STROKE_SECONDARY = 1.5;
/** Sparkline 描边宽度（细线） */
export const SPARKLINE_STROKE = 1.5;

/** 区域填充透明度（AreaChart 主/次共用，Sparkline 略不同） */
export const AREA_FILL_OPACITY = 0.15;
export const SPARKLINE_FILL_OPACITY = 0.15;

/* ============================================================
 * 通用工具
 * ========================================================== */

/**
 * 安全归一化的最大值：给定一组数值返回 max(values, 1)。
 * 至少返回 1 避免后续除零（空数据 / 全 0 数据的退化情形）。
 *
 * 实现用循环而非 `Math.max(...values, 1)` —— 后者 spread 展开数组，
 * values 极大（> ~100k）时会触发调用栈溢出；本组件实际数据量小，
 * 但作为通用工具函数用 reduce 求最值更健壮（无栈深上限）。
 *
 * @param values 要扫描的数值序列（已扁平化，可来自多条数据线）
 */
export function safeMaxValue(values: number[]): number {
  // reduce 求最值：空数组时初值 1，保证返回值恒 ≥ 1（防除零）
  return values.reduce((acc, v) => (v > acc ? v : acc), 1);
}

/* ============================================================
 * 坐标映射
 * ========================================================== */

/**
 * 把数据点索引 + 数值映射到 SVG 坐标（AreaChart 用）。
 *
 * X 轴：索引均匀分布在 [padding.left, padding.left + chartWidth] 区间；
 * Y 轴：value/maxVal 归一化到 [0, 1] 再反转（SVG y 向下）映射到绘图区。
 *
 * @param index  当前点索引（0-based）
 * @param value  当前点数值
 * @param count  数据点总数（决定 X 步长）
 * @param maxVal Y 轴最大值（归一化基准，建议传 safeMaxValue 结果）
 * @param width  绘图区宽度（不含 padding）
 * @param height 绘图区高度（不含 padding）
 * @param padding 内边距（决定原点偏移）
 */
export function pointToCoord(
  index: number,
  value: number,
  count: number,
  maxVal: number,
  width: number,
  height: number,
  padding: ChartPadding,
): Point {
  // step：count > 1 时均匀分布，否则 0（防御性 —— 调用方 buildSmoothPaths/normalizePoints
  // 已在入口拦掉 <2 点场景，此分支理论上不可达，但作为纯函数保留兜底避免误传单点时 NaN）
  const step = count > 1 ? width / (count - 1) : 0;
  return {
    x: padding.left + index * step,
    y: padding.top + height - (value / maxVal) * height,
  };
}

/**
 * 查询某点的 SVG 坐标（AreaChart tooltip 圆点定位用）。
 * 与 {@link pointToCoord} 同算法，但接受完整 DataPoint 而非裸 value，
 * 便于交互时按 index 反查（避免每次解构 `data[idx].value`）。
 */
export function pointCoordAt(
  index: number,
  point: DataPoint,
  count: number,
  maxVal: number,
  width: number,
  height: number,
  padding: ChartPadding,
): Point {
  return pointToCoord(index, point.value, count, maxVal, width, height, padding);
}

/**
 * 把任意数值序列按 min/max 归一化映射到 SVG 坐标（Sparkline 用）。
 *
 * 与 AreaChart 的差异：
 *  - AreaChart Y 轴始终从 0 起（maxVal = max(values, 1)，min 固定 0）
 *  - Sparkline 双轴都按实际 min/max 自适应归一化，让波动更明显（小范围趋势不丢失）
 *
 * @param values 数值序列
 * @param width  SVG 总宽（含 pad，函数内部减掉）
 * @param height SVG 总高（含 pad，函数内部减掉）
 * @param pad    四周留白（默认 {@link SPARKLINE_PAD}）
 */
export function normalizePoints(
  values: number[],
  width: number,
  height: number,
  pad = SPARKLINE_PAD,
): Point[] {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const w = width - pad * 2;
  const h = height - pad * 2;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  // range = max - min，退化（max===min 全相等序列）时取 1 避免除零：
  // 此时 (v - min) === 0，归一化为 0 → y 贴底。为让全相等序列显示为水平中线
  // 而非贴底（视觉上常量序列更自然是水平居中），当 range 为 0 时把所有点归一到中线。
  if (max - min === 0) {
    // 全相等序列：所有点落在绘图区垂直中线（pad + h/2）
    const midY = pad + h / 2;
    return values.map((_, i) => ({ x: pad + i * step, y: midY }));
  }
  const range = max - min;
  return values.map((v, i) => ({
    x: pad + i * step,
    y: pad + h - ((v - min) / range) * h,
  }));
}

/* ============================================================
 * 平滑曲线 path 构建
 * ========================================================== */

/**
 * 把点序列转成贝塞尔曲线 path 字符串。
 *
 * 平滑策略：每段控制点 x = 两端点 x 中点，控制点 y = 各自端点 y。
 * 这样曲线会精确穿过每个数据点（不像样条插值会偏离），
 * 同时在点之间产生连续平滑过渡——视觉接近 Chart.js 的默认 tension。
 *
 * 抽象出来同时服务 AreaChart 和 Sparkline：重构前两个文件各写一份近 100% 重复的代码。
 *
 * @param points 点序列（长度 ≥ 2 才有意义）
 * @returns SVG path `d` 字符串；points 长度 < 2 时返回空串
 */
export function smoothLinePath(points: Point[]): string {
  if (points.length < 2) return "";
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const cpx = (prev.x + curr.x) / 2;
    d += ` C ${cpx} ${prev.y}, ${cpx} ${curr.y}, ${curr.x} ${curr.y}`;
  }
  return d;
}

/**
 * 构建区域闭合 path（线条 + 半透明填充用）。
 *
 * 在 {@link smoothLinePath} 的同款贝塞尔算法基础上：从基线起 → 沿曲线走 → 回基线闭合（Z）。
 * baseline = 绘图区底部（AreaChart）或 SVG 底部（Sparkline）。
 *
 * 不复用 smoothLinePath 的字符串输出 —— 直接内联同样的曲线段生成逻辑，
 * 避免用正则剥掉前导 `M x y` 这种脆弱的字符串拼接式复用
 * （依赖 smoothLinePath 输出格式的精确形态，负数坐标 / 多空格 / 科学计数法都会让正则失配，
 *  区域 path 会残留多余的 M 段导致错误渲染）。
 *
 * @param points    点序列（≥ 2）
 * @param baselineY 基线 y 坐标（区域下边界）
 * @returns SVG path `d` 字符串；points 长度 < 2 时返回空串
 */
export function smoothAreaPath(points: Point[], baselineY: number): string {
  if (points.length < 2) return "";
  // 起点：从基线垂直进入第一个数据点（L），后续复用与 smoothLinePath 相同的 C 段
  let d = `M ${points[0].x} ${baselineY} L ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    // 控制点 x = 两端点 x 中点，控制点 y = 各自端点 y —— 与 smoothLinePath 同算法
    const cpx = (prev.x + curr.x) / 2;
    d += ` C ${cpx} ${prev.y}, ${cpx} ${curr.y}, ${curr.x} ${curr.y}`;
  }
  // 末点回到基线并闭合（Z）—— 形成"基线 → 曲线 → 基线"封闭区域用于 fill
  return d + ` L ${points[points.length - 1].x} ${baselineY} Z`;
}

/**
 * 同时构建线条 + 区域 path（AreaChart 主/次线复用，一次过）。
 *
 * @param data       数据点序列
 * @param maxVal     Y 轴最大值（归一化基准）
 * @param width      绘图区宽度
 * @param height     绘图区高度
 * @param padding    内边距
 * @returns `{ line, area }`；data 长度 < 2 时两者均为空串
 */
export function buildSmoothPaths(
  data: DataPoint[],
  maxVal: number,
  width: number,
  height: number,
  padding: ChartPadding,
): { line: string; area: string } {
  if (data.length < 2) return { line: "", area: "" };
  const points = data.map((p, i) =>
    pointToCoord(i, p.value, data.length, maxVal, width, height, padding),
  );
  const baseline = padding.top + height;
  return {
    line: smoothLinePath(points),
    area: smoothAreaPath(points, baseline),
  };
}

/* ============================================================
 * Y 轴刻度 / X 轴标签
 * ========================================================== */

/**
 * 构建 Y 轴刻度（数值 + y 坐标），AreaChart 网格线 + 标签复用。
 *
 * @param maxVal 最大值
 * @param count  刻度数量（含 0 和 maxVal 两个端点，常见 4 或 5）
 * @param height 绘图区高度
 * @param padding 内边距
 */
export function buildYTicks(
  maxVal: number,
  count: number,
  height: number,
  padding: ChartPadding,
): { value: number; y: number }[] {
  return Array.from({ length: count }, (_, i) => {
    const value = Math.round((maxVal / (count - 1)) * i);
    const y = padding.top + height - (value / maxVal) * height;
    return { value, y };
  });
}

/**
 * 判定某索引的 X 轴标签是否应该显示（均匀采样避免拥挤）。
 *
 * 规则：i 是采样步长整数倍、或最后一个点 → 显示；其余跳过。
 * 采样步长 = ceil(count / max)，保证总数不超过 max。
 *
 * @param index 当前索引
 * @param count 数据点总数
 * @param max   最多显示的标签数（默认 {@link AREA_CHART_X_LABEL_MAX}）
 */
export function shouldShowXLabel(index: number, count: number, max = AREA_CHART_X_LABEL_MAX): boolean {
  if (count === 0) return false;
  // 最后一个点强制显示（标记终点）
  if (index === count - 1) return true;
  const step = Math.ceil(count / max);
  return index % step === 0;
}
