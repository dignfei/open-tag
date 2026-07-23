# Icon motion — 原理与方法论

open-tag 图标微交互系统（`web/src/iconMotion.css`）。原理逆向自
[Amicro](https://amicro.vercel.app/)（[Subhan-code/Amicro--Micro-transitions-](https://github.com/Subhan-code/Amicro--Micro-transitions-)，MIT），
本文所有结论均出自其真源码 `src/components/AnimatedButton.tsx`（下文行号 = 该文件），非视觉猜测。

## 1. 原站动效为什么好看 —— 三条原理

**① 一颗统一的 spring 定义全部"手感"。**
Amicro 几乎所有变体共用 `spring(stiffness: 600, damping: 25)`（L101/117/138/195/206/276/287），
rotate 用 600→400（L239）、layout 用 500（L393）——快起步、一次轻微过冲、~150ms 内收敛。
动效之间的"家族感"完全来自这一颗曲线，而不是每个图标各调各的。

**② 固定尺寸舞台，动效不挤压布局。**
每个图标包在 `relative w-4 h-4` 的定宽容器里，交换的两个图标 `absolute inset-0` 叠放
（L187/196/207）。图标怎么缩放/旋转/换位，按钮尺寸纹丝不动 —— 没有 layout shift 才敢做大幅动效。

**③ 动效语义化：动作暗示结果，而不是装饰。**
每个图标的动法来自它的动词：齿轮转（设置=调节，L239）、垃圾桶抖（删除=危险，L252-255）、
心脏搏动（喜欢，L225）、书签被填色（收藏=着色标记，L61-62 color-morph）、纸飞机起飞（发送）。
同一颗 spring + 不同语义变奏，才是"整套图标都讲究"的观感来源。

工程细节（同样值得抄）：hover 只在支持 hover 的设备生效
（`matchMedia('(hover: hover)')`，L41 —— 防触屏 sticky 态）；键盘 focus 复用 hover 动效（L397-398）。

## 2. 我们的实现：纯 CSS，零依赖

Amicro 用 framer-motion（`motion` v12）。open-tag **没有**这个依赖，且图标动效全部是
hover 微交互，为此引入 ~30KB 运行时不划算（消息 hover 工具条是热路径，每行消息挂
motion 组件成本更高）。spring 手感用**单次过冲贝塞尔**近似：

```css
--im-spring: cubic-bezier(0.34, 1.56, 0.64, 1);  /* ≈ spring(600, 25) */
```

**与动效宪法的关系**（[`docs/motion-charter.md`](./motion-charter.md)）：宪法红线禁
bounce/elastic 曲线；图标 hover 微交互获**限定豁免**（宪法 §1.1）——`--im-spring` 与
`--ease-*`/`--dur-*` 一起定义在 `styles.css :root`，**只许用于图标 hover/focus 反馈**，
进场/切换/循环动效仍走 `--ease-quint`/`--ease-expo`。transition 时长直接复用宪法档位：
`--dur-slow`（常规）/ `--dur-signature`（齿轮旋转）/ `--dur-fast`（按压反馈）。

> 何时才值得上 JS/motion：需要**中断重定向**（hover 一半移出，spring 从当前速度弹回——CSS
> transition 只会生硬反转）、magnetic 鼠标跟踪（L50-55）、AnimatePresence 式挂载/卸载动画。
> hover 微交互不属于这三类。

## 3. 变体对照表（Amicro → open-tag）

| Amicro 变体（行号） | 原实现 | 我们的类 | 应用点 |
|---|---|---|---|
| matrix hover / `whileHover`（L410） | scale spring | `im-pop` | rail 导航、工具条 Clipboard/More、传图 |
| `rotate`（L239） | rotate 180° spring(400,25) | `im-rotate` | rail 设置齿轮 |
| `shake`（L252-256） | y[0,-2,0,-2,0] rotate[0,±10] 0.4s | `im-shake` | 任务删除 Trash2、告警三角 |
| `pulse`（L225-226） | scale[1,1.25,1] 0.4s | `im-pulse` | 表情回应 Smile |
| `color-morph`（L61-62, L198） | hover 换成填色图标 | `im-fill` | 消息收藏 Bookmark（fill 预览） |
| `slide-arrow`（L90-124） | 图标让位/箭头进场 | `im-nudge-up` | 发送 Send、跳转 ExternalLink |
| （同上，重力方向） | — | `im-bounce-down` | 附件下载 Download |
| （spring 语言扩展） | — | `im-tilt` | 附件回形针 Paperclip |
| `whileTap`（L411） | scale 0.96 | `.im:active` 规则 | pop/nudge 类 |

**没搬的**（及原因）：`sparkle` 星星粒子（L153-174，装饰性强，编辑风克制原则不符）、
`magnetic`（L50-55，需 JS 鼠标跟踪）、`glare`/`expand-ring`/`text-reveal`（按钮级效果，
本次范围是图标）、`morph` 双图标交换 —— 见 §5 配方，等有真实状态场景再用。

## 4. 使用方法（两个类，没有第三步)

```tsx
// 触发器 `im` 放在交互元素上（button/a），效果类放在图标上：
<button className="cb-icon im" …><Paperclip size={16} className="im-tilt" /></button>
```

- lucide-react 图标直接收 `className`；自家 `icons.tsx` 图标同样支持（Svg 已透传）。
- 所有 hover 规则包在 `@media (hover: hover) and (prefers-reduced-motion: no-preference)`
  里：触屏无 sticky 态，减动效偏好整体关闭（这点比原站做得多）。
- `:focus-visible` 镜像 hover（对应原站 onFocus/onBlur，L397-398）：键盘 Tab 到按钮同样触发动效。
- 新图标选效果时**先问语义**（这个动作的动词是什么），语义没有明显动法就用 `im-pop`，
  不要发明新变体；确要新增 → 必须复用 `--im-spring` + 宪法时长档位（`--dur-*`），并更新本文对照表。

## 5. 双图标交换配方（`morph`，按需引入）

Amicro 的旗舰效果（L183-218）：Copy→Check、Moon→Sun、Lock→Unlock。**本质是状态切换而非
hover 装饰**，所以配方放这里、CSS 不预置（避免 dead code）。需要时：

```css
.im-swap { display: inline-grid; place-items: center; }
.im-swap > * { grid-area: 1 / 1; transition: opacity .2s ease, transform var(--dur-slow) var(--im-spring); }
.im-swap > .off { opacity: 0; transform: scale(.5); }   /* L192: initial scale 0.5 + opacity 0 */
```

```tsx
<span className="im-swap">
  <Clipboard className={copied ? "off" : ""} size={15} />
  <Check className={copied ? "" : "off"} size={15} />
</span>
```

两个图标叠在同一个 grid 格（= 原理②的固定舞台），由 app state（`copied`）驱动，不用 hover。

## 6. 验证

改到 `iconMotion.css` / 动效类后：跑真实 app（dev server + 浏览器），逐个 hover 截图；
`getComputedStyle(icon).transform` 在 hover 态应输出对应矩阵（rotate 180° → `matrix(-1,0,0,-1,0,0)`）。
触屏模拟（emulate touch）下 hover 不得触发；`prefers-reduced-motion: reduce` 下全部静止。
