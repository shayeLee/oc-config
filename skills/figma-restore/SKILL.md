---
name: figma-restore
description: 还原 Figma 设计稿到项目 UI / restore Figma design to code。触发词：还原 Figma 设计稿、把设计稿做成页面、按设计稿还原这屏、restore/implement Figma design、按 Figma 写 UI
argument-hint: "<Figma 链接> [第二条链接 ...]"
allowed-tools: Bash Read Write Edit AskUserQuestion
---

# Figma 还原 UI — 完整方法论

> 这份 skill 是**可移植方法论**，覆盖取数 → 读图层 → 写码还原全流程。
> 项目专属常量（单位换算、资源目录、i18n、浏览器基线、验证方式）**不在 skill 里预设**，执行时直接向用户确认，确认后写入项目 `AGENTS.md` 长期记忆，下次免问。

---

## 🔴 第一原则

**设计稿是最高准则。** 现有代码与设计稿有任何冲突，一律改成设计稿值，不沿用旧值，不需逐次询问。

---

## 前置条件

- 用户给一条（或多条）**Figma 链接**即可，格式：
  `https://www.figma.com/design/<fileKey>/...?node-id=<a-b>`
- 需要 Figma Personal Access Token（`FIGMA_TOKEN`）——走 REST API。
- 取不到 token 时**不静默失败**，明确提示用户：
  - 去 Figma 菜单 → Help & account → Account settings → Personal access tokens → 生成一条
  - 设到环境变量 `FIGMA_TOKEN=figd_xxx`，或写进项目根 `.env.figma`（一行 `FIGMA_TOKEN=figd_xxx`）
  - ⚠️ 不要把 token 贴进对话，不要提交进仓库

### Figma 配额耗尽 / 持续 429 时的兜底（手动喂数据）

REST API 是**按座席分档限流**的（`X-Figma-Rate-Limit-Type: low` = Collab/Viewer 座席，月配额极小）。一旦配额耗尽，`/v1/files/.../nodes` 会持续返回 **429**，响应头 `Retry-After` 可能是**几十小时**（按月窗口滚动），**重试和退避都救不了**——别反复打 API（越打越糟），先用一次最小请求确诊：

```bash
curl -s -D - -o /dev/null -H "X-Figma-Token: $TOKEN" \
  "https://api.figma.com/v1/files/<fileKey>/nodes?ids=<a>%3A<b>" \
  | grep -iE "HTTP/|retry-after|x-figma-rate-limit-type"
```

确诊为配额耗尽后**不静默失败、不空等**，明确告诉用户：等待不现实（要等月窗），并请他**手动喂数据**——脚本产物本来就落 `.figma/<nodeId>/`，用户把对应文件丢进去即可，后续 Phase 2/3 完全照常：

| 让用户提供 | 放到 | 作用 |
|---|---|---|
| **2x 截图**（选中节点导出 2x PNG） | `.figma/<nodeId>/render@2x.png` | 替代渲染图，人眼逐区块对照（颜色/间距/字号/图标形状） |
| **SVG 图标**（选中图标 → 右键 Copy as SVG / 导出 SVG） | `.figma/<nodeId>/icons/<name>.svg` | 矢量图标真实路径 + 精确色值（比目测/本地合成可靠） |
| **位图素材**（导出 PNG/JPG） | `.figma/<nodeId>/assets/<name>.png` | 背景图/插画等位图 |

- **能从截图直接读的**（布局、文案、大致配色、按钮样式、行序）自己定；**截图量不准的**（精确 hex / 字号 / 行高 / 圆角 / 间距 px / 投影参数 / 禁用态色值）列一张最小清单交用户逐项补——别让用户把整份 JSON 抄给你。
- SVG 里的 `fill` 是**可靠色值来源**（如 `#0091FF`/`#FF7D00`）；间距/字号这类没 `node.json` 时只能目测估值，**写码时标注哪些是估值**，等配额恢复后可重跑 `figma-fetch`（或 `--inspect`）逐像素校准。
- 仍提醒把 `.env.figma`、`.figma/` 加进 `.gitignore`。

---

## Phase 1 — 取数

```bash
node ~/.claude/skills/figma-restore/scripts/figma-fetch.mjs \
  "https://www.figma.com/design/<fileKey>/...?node-id=2004-2682" \
  ["第二条链接" ...]
```

- 脚本自动从链接解析 file key + node-id（URL 中 `-` 转 API 的 `:`）
- 兼容旧式：`node figma-fetch.mjs <fileKey> <nodeId>` 仍有效
- **产物**落 `<cwd>/.figma/<nodeId>/`：

| 文件 | 内容 |
|---|---|
| `node.json` | 图层子树 JSON（含 geometry=paths，是读图层的原始数据） |
| `render@2x.png` | 整屏 2x 渲染图（人眼对照用） |
| `report.json` | 资源分类报告（位图/图标/文本三列表） |
| `icons/<name>.svg` | 矢量图标（本地合成 or API 导出） |
| `assets/<ref>.png` | 位图素材 |

- 有缓存则跳过请求，幂等可重跑
- 提醒把 `.env.figma`、`.figma/` 加进项目 `.gitignore`

---

## Phase 2 — 读图层

### 资源分类（看 report.json）

| 类型 | 识别方式 | 处理 |
|---|---|---|
| 位图 | `fills[].type === 'IMAGE'`（有 imageRef），**或** `exportSettings` 含 PNG/JPG | 前者走 `/files/{key}/images` 取 CDN URL，后者走 `/v1/images` 渲染 API；都落项目图片引用约定 |
| 矢量图标 | `exportSettings` 含 SVG，**或** 尺寸 < 100px 的纯矢量 INSTANCE/COMPONENT/FRAME（不靠 depth——图标可能嵌在任意层级） | 本地合成 SVG，或 API 导出 |
| 文本 | `type === 'TEXT'` | 读 `characters`/`style`（含 `lineHeightPx`），走项目 i18n |

### 尺寸/间距取证规则（必须，不能目测渲染图）

```
宽高    → node.absoluteBoundingBox.{width, height}
左间距  → node.absoluteBoundingBox.x - parent.absoluteBoundingBox.x - parent.paddingLeft
右间距  → (parent.absoluteBoundingBox.x + parent.absoluteBoundingBox.width)
          - (node.absoluteBoundingBox.x + node.absoluteBoundingBox.width)
          - parent.paddingRight
```
回答取证结论时**说明来自哪个字段**，不靠目测。

### ⚠️ 踩坑清单

1. **外部库 INSTANCE**：`node.componentId` 不在文件 `nodesData.components` 表 → `fillGeometry` 只是边界框，不是真实路径。**且要递归检测子树**——一个 FRAME 自己不是 INSTANCE，但子节点是外部库 INSTANCE 时，本地合成同样得到空壳。这类必须 API 导出（`/v1/images?format=svg`）或在 Figma 手动 Copy as SVG，不能本地合成。
2. **隐藏节点**：`visible === false` → 整棵子树跳过，不识别为图标或文本。脚本 `analyzeNode` 已内置此过滤；**但你另写临时取证脚本遍历 `node.json` 时极易漏**——遍历第一行就 `if (node.visible === false) return`，否则会把隐藏的备用态/占位节点（带完整 box/fills）误当成「设计稿有这个元素」（反复踩的坑）。
3. **限流 Retry-After**：Figma 有时返回绝对 Unix 时间戳而非相对秒数，收到后 cap 到合理范围（≤ 300s），指数退避。
4. **本地合成 SVG 定位**：不做矩阵乘法，用 `absoluteBoundingBox` 差值（`dx = node.x - root.x`），跳过无 SOLID fill 的路径（仅点击区域的 fill=undefined/IMAGE 类路径）。

---

## Phase 3 — 写码还原

### 先问项目常量

下列随项目不同，执行前用 **AskUserQuestion** 向用户一次性确认（若 `AGENTS.md` 已有则跳过；确认后若未记录就写入 `AGENTS.md`）：

| 常量 | 示例（gfs-flowers，仅参考） |
|---|---|
| 设计稿宽度 & 尺寸单位换算 | 750px 设计稿，`rpx(x) = x/750*100 rem` |
| SVG/位图资源落位目录 | `app/assets/img/` |
| SVG 引用方式 | `background-image: url()` 相对路径（无 SVGR） |
| i18n 策略 | `$t('中文')` 占位，不自造 key、不跑 i18n 命令 |
| 多语言？最长语言？ | 是（EN/DE/JA），文案按最长语言留溢出兜底 |
| 浏览器兼容基线 | 老 webview：禁 `gap`/`:has()`/`inset` |
| 验证方式 | 有测试：跑至全绿；无测试：构建+视觉核对 |

### 根节点落点

**Figma node 是「样式的标准」——设计态的枚举展开**：设计师把每个状态各画一个 node。
代码侧由**业务状态（state）驱动**：同一组件 / HTML 节点，UI 是 state 的函数，不同 state 取不同样式。
**还原 = 拿 Figma 各设计态 node 当样式标准，去填代码里每个业务 state 对应的样式。**

所以一条链接落到代码里是**按职责对应到某个组件/样式单元**，不按 node 数量一一对应——
figma 是「静态枚举」、代码是「运行时按 state 求值」，本不在一个维度数节点，两者天然 N:M：

- **同一元素的多个状态 node**（常态/错误/禁用）→ 代码 **1 个组件，按 state 切样式**（修饰类 / props / 伪类），从各状态 node 取对应令牌，不建多份 DOM
- **重复的同类 node**（如表单里 7 个 input）→ **同一组件复用 N 次**，数据/props 驱动差异

子节点同样不强求与 DOM 一一对应，按设计稿语义还原即可。

### node.json → CSS 映射（要点）

详细查表见 `reference/node-json-to-css.md`，高频字段：

```
layoutMode: HORIZONTAL/VERTICAL  →  display:flex; flex-direction:row/column
primaryAxisAlignItems            →  justify-content (SPACE_BETWEEN→space-between, CENTER→center…)
counterAxisAlignItems            →  align-items
itemSpacing                      →  间距（用 margin，gap 视浏览器基线）
paddingLeft/Right/Top/Bottom     →  padding
cornerRadius                     →  border-radius
fills[0].color (SOLID)           →  十六进制颜色
style.fontSize/fontWeight        →  font-size/font-weight
style.lineHeightPx               →  line-height
style.letterSpacing              →  letter-spacing
strokes + strokeWeight           →  border
effects[].DROP_SHADOW            →  box-shadow
```

无 `layoutMode`（无自动布局）→ 用 `absoluteBoundingBox` 差值做绝对定位。

### 多语溢出兜底（多语项目通用）

每处文案都按最长语言考虑，不写死 `white-space: nowrap`：

```css
/* 单行截断 */
overflow: hidden;
text-overflow: ellipsis;
white-space: nowrap;

/* 多行截断（老 webkit 可用） */
display: -webkit-box;
-webkit-box-orient: vertical;
-webkit-line-clamp: 2;
overflow: hidden;
```

### 通用工作节奏

1. **每屏先复盘**：列出本屏涉及的资源（位图/图标/文本）与尺寸取证结果，再开始写
2. **对照 render@2x.png**：逐区块核对（颜色/间距/字号/图标形状）
3. **设计稿取值 > 现有代码**：发现冲突直接改，不询问

---

## Verify

按目标项目的验证约定：
- **有测试** → 循环跑至全绿
- **无测试** → 构建/类型检查通过 + 对照 `render@2x.png` 视觉核对
- 是否跑 dev server 等由该项目习惯决定，不在此预设

### 系统性数据核对（强烈推荐，render 图拿不到时的主力复核）

写完后跑一次**全树数据核对**，不依赖渲染图。直接用脚本的 `--inspect` 子命令（内置 `visible:false` 过滤，不发请求/不需 token）：

```bash
node ~/.claude/skills/figma-restore/scripts/figma-fetch.mjs --inspect "<Figma 链接或 nodeId（如 2004-2684）>"
```

它 dump 全树**仅可见**节点的几何/文本/字号/颜色/间距/圆角，你据此与写的 CSS/markup **逐项对照**，列一张「设计稿节点 → 我的实现 → 是否一致」表。

- **别再手搓临时遍历脚本**——历史上手搓时反复漏过滤 `visible:false`，把隐藏的备用态/占位节点（带完整 box/fills）误当成「设计稿有这个元素」。`--inspect` 已把过滤机制化，用它即可。
- **能抓**：数值偏差、遗漏/多余节点、结构错位——凡 `node.json` 里有的数据。
- **抓不到**：像素级渲染观感（字体/图片/整体协调度），以及你对数据的**系统性误解**（如错把 `visible:false` 当成要还原的）——这类只能靠真实渲染图 / 真机 / 用户肉眼。
- 所以它与渲染图肉眼核对**互补、不互替**；但在 `render@2x.png` 因限流/无 token 拿不到时，它是主力复核手段。

完成后输出：
- ✅ 已还原内容清单
- 🔲 人工核对清单（对照 render@2x.png 逐项）
- 📋 i18n 待办（新字符串 key 列表，交用户录入翻译系统）
