# node.json → CSS 映射详表

Figma REST API 返回的节点 JSON 字段与 CSS 属性的对应关系。
**尺寸单位随项目而定**（px / rem / vw / rpx / tailwind 等），执行前向用户确认。

> **数据来源与权威性**：字段名取自 Figma REST API（`GET /v1/files/:key/nodes` 的 Node 类型）。本表是**人工整理的二手映射**，核心字段（layoutMode / padding / itemSpacing / cornerRadius / strokes / lineHeightPx / fills 等）已被真实 `node.json` 印证；遇到本表未覆盖或存疑的字段，**以官方 API 文档 + 实际 `--inspect` 出的 `node.json` 为准**。
> **维护方式**：Figma API 核心字段多年稳定，按需增量维护即可——遇到新字段/新坑再补，不必主动追全。校验最可靠的办法是拿真实 `node.json` 对照本表。

---

## 布局（Auto Layout）

| node.json 字段 | 值 | CSS |
|---|---|---|
| `layoutMode` | `HORIZONTAL` | `display: flex; flex-direction: row` |
| `layoutMode` | `VERTICAL` | `display: flex; flex-direction: column` |
| `primaryAxisAlignItems` | `MIN` | `justify-content: flex-start` |
| `primaryAxisAlignItems` | `CENTER` | `justify-content: center` |
| `primaryAxisAlignItems` | `MAX` | `justify-content: flex-end` |
| `primaryAxisAlignItems` | `SPACE_BETWEEN` | `justify-content: space-between` |
| `counterAxisAlignItems` | `MIN` | `align-items: flex-start` |
| `counterAxisAlignItems` | `CENTER` | `align-items: center` |
| `counterAxisAlignItems` | `MAX` | `align-items: flex-end` |
| `counterAxisAlignItems` | `BASELINE` | `align-items: baseline` |
| `itemSpacing` | 数值 | 间距：优先用 `margin`（`gap` 视浏览器基线决定，老 webview 不支持） |
| `paddingLeft/Right/Top/Bottom` | 数值 | `padding-left/right/top/bottom` |
| `layoutSizingHorizontal` | `FILL` | `flex: 1` 或 `width: 100%` |
| `layoutSizingHorizontal` | `HUG` | `width: fit-content` |
| `layoutSizingHorizontal` | `FIXED` | `width: <absoluteBoundingBox.width>` |

> **无 layoutMode（无自动布局）**：用 `absoluteBoundingBox` 差值做绝对/相对定位：
> `left = node.x - parent.x - parent.paddingLeft`

---

## 尺寸

```
宽：absoluteBoundingBox.width
高：absoluteBoundingBox.height
```

> ⚠️ **`absoluteBoundingBox` 的边界含义**：它含**外描边外延**（`strokeAlign: OUTSIDE/CENTER` 时框比可视内容大 ~strokeWeight），但**不含阴影/模糊**（那是 `absoluteRenderBounds`，含 drop-shadow 与 blur，通常更大）。取「内容盒」尺寸用 `absoluteBoundingBox`；若节点有外描边、且你的 CSS 用 `border-box`，记得扣掉描边外延，免得整体大一圈。

**怎么转成 CSS 单位 —— 随项目而定，示例：**

| 项目约定 | 转换方式 |
|---|---|
| 直接 px（Web PC） | `${w}px` |
| rem（设计稿 16px = 1rem） | `${w / 16}rem` |
| vw（满屏 100vw） | `${w / 设计宽 * 100}vw` |
| rpx（H5 750 设计宽，gfs-flowers 示例） | `rpx(${w})` → `w/750*100 rem` |
| Tailwind | 查 spacing scale，或用 `[${w}px]` arbitrary value |

---

## 颜色 & 填充

```js
// 先过滤隐藏 fill（fill 可被单独隐藏，取色前必须排除），再取最上层 SOLID
const fill = (node.fills || []).filter(f => f.visible !== false && f.type === 'SOLID')[0]
const color = fill?.color  // {r, g, b} 各 0~1
// 最终透明度 = 节点 opacity × fill opacity（两者相乘）
const alpha = (node.opacity ?? 1) * (fill?.opacity ?? 1)

const hex = '#' + ['r','g','b'].map(k => Math.round(color[k] * 255).toString(16).padStart(2, '0')).join('')
// alpha < 1 时用 rgba(...)
```

> ⚠️ **`fills[0]` 未必是主色**：一个节点可叠多层 fill，且其中任意层可能 `visible:false`。单 fill 时直接取 `[0]`，多 fill 时按叠放顺序判断哪层是你要的可见色——别无脑取 `[0]`。

| Figma 填充类型 | CSS 处理 |
|---|---|
| `SOLID` | `background-color` / `color` / `border-color` |
| `GRADIENT_LINEAR` | `background: linear-gradient(...)` |
| `IMAGE` | 位图，走项目图片引用约定（`<img>` / `background-image`） |

---

## 文字

| node.json 字段 | CSS |
|---|---|
| `style.fontSize` | `font-size` |
| `style.fontWeight` | `font-weight` |
| `style.lineHeightPx` | `line-height`（绝对值）；`style.lineHeightUnit === 'PERCENT'` 时用 `style.lineHeightPercentFontSize / 100` |
| `style.letterSpacing` | `letter-spacing`（单位 px；`style.letterSpacingUnit === 'PERCENT'` 时 = value/1000 em） |
| `style.textAlignHorizontal` | `text-align`（LEFT/CENTER/RIGHT/JUSTIFIED） |
| `style.textDecoration` | `text-decoration`（UNDERLINE/STRIKETHROUGH） |
| `style.textCase` | `text-transform`（UPPER→uppercase / LOWER→lowercase） |
| `fills[0].color` (SOLID) | `color` |

**多语溢出兜底（多语项目必须）**：

```css
/* 单行 */
max-width: <容器宽>;
overflow: hidden;
text-overflow: ellipsis;
white-space: nowrap;

/* 多行（-webkit-line-clamp 老 webkit 可用） */
max-width: <容器宽>;
display: -webkit-box;
-webkit-box-orient: vertical;
-webkit-line-clamp: 2;  /* 根据行高和容器高度定 */
overflow: hidden;
```

---

## 边框 & 圆角

| node.json 字段 | CSS |
|---|---|
| `cornerRadius` | `border-radius` |
| `rectangleCornerRadii` | `border-radius: tl tr br bl`（四角不同时） |
| `strokes[0].color` + `strokeWeight` | `border: <strokeWeight>px solid <color>` |
| `strokeAlign` | **INSIDE**→`border` + `box-sizing: border-box`（border 内扣不撑大盒子，最常用）；不想占 border 槽时退而用 `box-shadow: inset 0 0 0 <w>px <color>`。**OUTSIDE**→`outline` 或外层包裹 |

---

## 阴影

```js
// effects[].type === 'DROP_SHADOW'，先过滤 visible:false 的 effect（同 fill，可被单独隐藏）
// color 是 {r, g, b, a}——alpha 在 color.a 里，没有单独的 opacity 字段
const e = (node.effects || []).filter(x => x.visible !== false && x.type === 'DROP_SHADOW')[0]
const { offset: { x, y }, radius, spread = 0, color } = e
css = `box-shadow: ${x}px ${y}px ${radius}px ${spread}px rgba(${Math.round(color.r*255)},${Math.round(color.g*255)},${Math.round(color.b*255)},${color.a})`
```

`INNER_SHADOW` → `box-shadow: inset ...`

---

## 不透明度

| node.json 字段 | CSS |
|---|---|
| `opacity` | `opacity`（节点整体；fills 里也有各自 opacity） |

---

## 定位（无 Auto Layout 时）

```
left   = node.absoluteBoundingBox.x - parent.absoluteBoundingBox.x
top    = node.absoluteBoundingBox.y - parent.absoluteBoundingBox.y
right  = (parent.x + parent.width) - (node.x + node.width)
bottom = (parent.y + parent.height) - (node.y + node.height)
```

父容器用 `position: relative`，子节点 `position: absolute`。

---

## 图标 / 矢量资源

- **本地合成 SVG**：见脚本 `buildSvgFromNode`，用 `absoluteBoundingBox` 差值 translate，跳过无 SOLID fill 路径
- **外部库 INSTANCE**（`componentId` 不在文件 `components` 表）：`fillGeometry` 是边界框非真实路径 → API `/v1/images?format=svg` 导出，或 Figma 手动 Copy as SVG
- SVG 落位目录与引用方式随项目约定（确认后写 `CLAUDE.md`）

---

## 常见遗漏检查项

- [ ] 所有文案节点：多语场景加 `max-width` + 截断兜底
- [ ] 文本节点别只取 `fontSize`：连 `style.lineHeightPx` 一并落 `line-height`（漏了行高会和设计稿垂直间距对不上）
- [ ] `visible === false` 的节点：设计稿里不显示，**不还原**（即使它有 `absoluteBoundingBox`，坐标会误导你以为它存在）
- [ ] 项目有单位换算函数（rpx/vw/rem 等）时，**所有尺寸值全程用该函数**，含 `border-width`/`line-height`，不混裸 `px`
- [ ] `gap` → 看浏览器基线，老 webview 改 `margin`
- [ ] `inset` shorthand → 写 `top/right/bottom/left`（老引擎不认 inset）
- [ ] `position: sticky` → 老引擎 graceful degradation 可接受（变 static 不崩版），但不能依赖 sticky 保证布局正确性
- [ ] `:has()` → 老引擎不支持，不用
- [ ] 图标尺寸和周围间距都要从 `absoluteBoundingBox` 量，别假设对称
