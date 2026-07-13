/**
 * figma-fetch.mjs — 可移植版 Figma 取数脚本
 * 用 Figma REST API 拉取图层数据 + 渲染图 + 位图/图标素材，输出资源分类报告。
 *
 * 用法（推荐）：直接传 Figma 链接，无需手拆 file key / node-id
 *   node figma-fetch.mjs "https://www.figma.com/design/<fileKey>/...?node-id=2004-2682"
 *   node figma-fetch.mjs "<链接1>" "<链接2>" ...
 *
 * 用法（兼容旧式）：
 *   node figma-fetch.mjs <fileKey> <nodeId> [nodeId2 ...]
 *
 * 系统性数据核对（Verify 阶段，纯读已缓存 node.json，不发请求/不需 token）：
 *   node figma-fetch.mjs --inspect "<Figma 链接或 nodeId（如 2004-2684）>"
 *   → dump 全树「仅可见」节点的几何/文本/样式，逐项对照你写的实现（内置 visible:false 过滤）
 *
 * Token 来源（按优先级）：
 *   1. 环境变量  FIGMA_TOKEN=figd_xxx
 *   2. 当前工作目录下的 .env.figma 文件（一行 FIGMA_TOKEN=figd_xxx）
 *   若两者都没有，脚本打印指引并退出。
 *
 * 产物（gitignored 的 <cwd>/.figma/<nodeId>/）：
 *   node.json          —— 图层子树 JSON（布局/尺寸/文本/fills/effects）
 *   render@2x.png      —— 整屏 2x 渲染图（人眼对照）
 *   assets/<ref>.png   —— 位图素材（fills.type=IMAGE 的 imageRef）
 *   icons/<name>.svg   —— 顶层矢量图标（VECTOR 或纯矢量 INSTANCE/FRAME）
 *   report.json        —— 资源分类报告（位图列表 + 图标列表 + 文本列表）
 *
 * 建议在项目 .gitignore 中加入：
 *   .env.figma
 *   .figma/
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

// ---------- 路径（基于 cwd，与脚本位置无关）----------
const CWD = process.cwd()
const CACHE_DIR = join(CWD, '.figma')

// ---------- 解析 Figma 链接 ----------
/**
 * 从 Figma 链接中提取 fileKey 和 nodeId。
 * 支持格式：
 *   https://www.figma.com/design/<fileKey>/...?node-id=2004-2682
 *   https://www.figma.com/file/<fileKey>/...?node-id=2004%3A2682
 *   https://www.figma.com/proto/<fileKey>/...?node-id=2004-2682
 * node-id 里的 `-` 或 `%3A`（URL 编码的 `:`）统一转成 API 要求的 `:`
 *
 * 返回 null 表示不像 URL，调用方回退到旧式解析。
 */
function parseFigmaUrl(arg) {
  let url
  try {
    url = new URL(arg)
  } catch {
    return null
  }
  if (!url.hostname.includes('figma.com')) return null

  // pathname: /(design|file|proto)/<fileKey>/...
  const parts = url.pathname.split('/').filter(Boolean)
  const typeIdx = parts.findIndex(p => ['design', 'file', 'proto'].includes(p))
  if (typeIdx === -1 || typeIdx + 1 >= parts.length) return null
  const fileKey = parts[typeIdx + 1]
  if (!fileKey) return null

  const rawNodeId = url.searchParams.get('node-id')
  if (!rawNodeId) {
    console.error(`❌ 链接中未找到 node-id 参数：${arg}`)
    console.error('   Figma 链接应包含 ?node-id=XXXX-XXXX 参数，选中图层后从浏览器地址栏复制。')
    process.exit(1)
  }
  // node-id 里 `-` 或 URL 编码的 `%3A` 都转成 `:`
  const nodeId = decodeURIComponent(rawNodeId).replace(/-/g, ':')

  return { fileKey, nodeId }
}

// ---------- 读 token ----------
function loadToken() {
  // 1. 环境变量
  if (process.env.FIGMA_TOKEN) return process.env.FIGMA_TOKEN.trim()

  // 2. cwd/.env.figma
  const envFile = join(CWD, '.env.figma')
  if (existsSync(envFile)) {
    const raw = readFileSync(envFile, 'utf8')
    const match = raw.match(/FIGMA_TOKEN\s*=\s*(.+)/)
    if (match) return match[1].trim()
  }

  // 两者都没有 → 明确报错指引，不静默失败
  console.error('❌ 找不到 Figma Personal Access Token。')
  console.error('')
  console.error('   获取方式：')
  console.error('   1. 打开 Figma → 右上角头像 → Settings（或 Help & account → Account settings）')
  console.error('   2. 左侧找 "Personal access tokens" → 点 "Generate new token"')
  console.error('   3. 填写名称，生成后**立即复制**（只显示一次）')
  console.error('')
  console.error('   设置方式（选其一）：')
  console.error('   方式 A：环境变量（当前终端有效）')
  console.error('     export FIGMA_TOKEN=figd_xxxxxxxxxxxx')
  console.error('')
  console.error('   方式 B：写入项目根 .env.figma 文件（长期有效，已 gitignored）')
  console.error('     echo "FIGMA_TOKEN=figd_xxxxxxxxxxxx" > .env.figma')
  console.error('')
  console.error('   ⚠️  不要把 token 贴进对话，不要提交进 git 仓库。')
  process.exit(1)
}

// ---------- fetch 工具 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function apiFetch(url, token, retries = 4) {
  for (let attempt = 0; attempt < retries; attempt++) {
    let res
    try {
      res = await fetch(url, { headers: { 'X-Figma-Token': token } })
    } catch (err) {
      // 网络抖动（ECONNRESET 等）也退避重试
      if (attempt < retries - 1) {
        const wait = Math.pow(2, attempt) * 5000
        console.warn(`   ⏳ 网络错误(${err.cause?.code ?? err.message})，${wait / 1000}s 后重试...`)
        await sleep(wait)
        continue
      }
      throw err
    }
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10)
      // Figma 有时返回绝对 Unix 时间戳而非相对秒数，cap 到合理范围（最多 60s）
      const fromHeader = retryAfter > 0 && retryAfter < 300 ? retryAfter * 1000 : 0
      const wait = fromHeader || Math.pow(2, attempt) * 10000 // 10s、20s、40s
      console.warn(`   ⏳ 限流(429)，${wait / 1000}s 后重试 (${attempt + 1}/${retries})...`)
      await sleep(wait)
      continue
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Figma API ${res.status}: ${url}\n${body}`)
    }
    return res.json()
  }
  throw new Error(`Figma API 持续 429，已重试 ${retries} 次: ${url}`)
}

async function downloadBinary(url, destPath) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`)
  writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
}

// ---------- 资源分析 ----------

/**
 * 判断一个节点是否「纯矢量」（自身或所有叶子节点都是 VECTOR/LINE 等，没有位图 fill）
 * 用于识别可以整体导出为 SVG 的图标组。
 */
function isPureVector(node) {
  // RECTANGLE 在 Figma 里也是矢量形状（不是 HTML div）
  const VECTOR_TYPES = new Set([
    'VECTOR', 'LINE', 'STAR', 'ELLIPSE', 'REGULAR_POLYGON',
    'BOOLEAN_OPERATION', 'RECTANGLE',
  ])
  if (VECTOR_TYPES.has(node.type)) return true
  if (['FRAME', 'GROUP', 'INSTANCE', 'COMPONENT'].includes(node.type) && node.children?.length) {
    return node.children.every(isPureVector)
  }
  return false
}

/**
 * 递归遍历节点树，收集三类资源：
 *   bitmaps  —— fills.type=IMAGE 的节点（位图，需下载 PNG）
 *   icons    —— 顶层纯矢量节点（图标，可导出 SVG）；一旦认定为图标就不再递归其子节点
 *   texts    —— type=TEXT 的节点（文案）
 */
function analyzeNode(node, bitmaps = [], icons = [], texts = [], depth = 0) {
  if (node.visible === false) return { bitmaps, icons, texts } // 隐藏节点整棵子树跳过

  // 位图识别：
  //   ① fills[].type === 'IMAGE'——节点有图片填充，imageRef 指向文件内嵌图片
  //   ② exportSettings 含 PNG/JPG——设计师显式标记为位图导出资产（无 imageRef，走渲染 API）
  if (node.fills) {
    for (const fill of node.fills) {
      if (fill.type === 'IMAGE' && fill.imageRef) {
        bitmaps.push({
          id: node.id,
          name: node.name,
          type: node.type,
          imageRef: fill.imageRef,
          size: sizeOf(node),
        })
      }
    }
  }
  const bitmapExport = (node.exportSettings || []).find(s => ['PNG', 'JPG', 'JPEG', 'WEBP'].includes(s.format))
  if (bitmapExport && depth >= 1) {
    const alreadyAdded = bitmaps.some(b => b.id === node.id)
    if (!alreadyAdded) {
      bitmaps.push({
        id: node.id,
        name: node.name,
        type: node.type,
        imageRef: null, // 无内嵌 ref，需走 /v1/images 渲染 API 下载
        exportFormat: bitmapExport.format,
        size: sizeOf(node),
      })
    }
  }

  // 文本
  if (node.type === 'TEXT') {
    texts.push({
      id: node.id,
      name: node.name,
      characters: node.characters,
      fontSize: node.style?.fontSize,
      fontWeight: node.style?.fontWeight,
      fills: (node.fills || [])
        .filter(f => f.type === 'SOLID')
        .map(f => rgbaStr(f.color, f.opacity)),
      size: sizeOf(node),
    })
    return { bitmaps, icons, texts }
  }

  // 矢量图标识别（跳过根节点 depth 0）：
  //   ① 设计师显式设置了 SVG 导出（exportSettings）——最可靠，无需猜测
  //   ② 或：节点类型是 INSTANCE/COMPONENT/FRAME + 尺寸 < 100px + 子树全矢量（isPureVector）
  //      尺寸过滤替代深度判断，兼容图标嵌在任意层级的复杂页面
  const IS_ICON_CANDIDATE = ['INSTANCE', 'COMPONENT', 'COMPONENT_SET', 'FRAME'].includes(node.type)
  const bb = node.absoluteBoundingBox
  const IS_SMALL = bb && bb.width < 100 && bb.height < 100
  const HAS_SVG_EXPORT = (node.exportSettings || []).some(s => s.format === 'SVG')
  if (depth >= 1 && IS_ICON_CANDIDATE && node.visible !== false && (HAS_SVG_EXPORT || (IS_SMALL && isPureVector(node)))) {
    icons.push({
      id: node.id,
      name: node.name,
      type: node.type,
      size: sizeOf(node),
    })
    return { bitmaps, icons, texts } // 不再递归子节点
  }

  if (node.children) {
    for (const child of node.children) {
      analyzeNode(child, bitmaps, icons, texts, depth + 1)
    }
  }

  return { bitmaps, icons, texts }
}

function sizeOf(node) {
  const bb = node.absoluteBoundingBox
  return bb ? { w: Math.round(bb.width), h: Math.round(bb.height) } : null
}

function rgbaStr(color, opacity = 1) {
  if (!color) return ''
  const r = Math.round((color.r ?? 0) * 255)
  const g = Math.round((color.g ?? 0) * 255)
  const b = Math.round((color.b ?? 0) * 255)
  const a = (opacity ?? 1).toFixed(2)
  return a === '1.00' ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`
}

/** 对图标去重：同名且同尺寸的只保留一个 */
function dedupeIcons(icons) {
  const seen = new Set()
  return icons.filter(ic => {
    const key = `${ic.name}__${ic.size?.w}x${ic.size?.h}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---------- 本地合成 SVG（从 fillGeometry 路径数据，无需 API 调用）----------

function figmaColorToHex(color) {
  if (!color) return '#000000'
  const r = Math.round((color.r ?? 0) * 255).toString(16).padStart(2, '0')
  const g = Math.round((color.g ?? 0) * 255).toString(16).padStart(2, '0')
  const b = Math.round((color.b ?? 0) * 255).toString(16).padStart(2, '0')
  return `#${r}${g}${b}`
}

/** 递归收集所有有 fillGeometry 且可见的叶子节点 */
function collectVectorLeaves(node, leaves = []) {
  if (node.visible === false) return leaves
  if (node.fillGeometry?.length) {
    leaves.push(node)
  }
  if (node.children) {
    for (const child of node.children) collectVectorLeaves(child, leaves)
  }
  return leaves
}

/**
 * 从 INSTANCE/COMPONENT 节点本地合成 SVG。
 *
 * 定位策略：fillGeometry 路径坐标是 VECTOR 自身的本地空间（0 到节点宽高）。
 * 将每个 VECTOR 在图标内的偏移用 absoluteBoundingBox 差值计算：
 *   dx = vector.absoluteBoundingBox.x - icon.absoluteBoundingBox.x
 *   dy = vector.absoluteBoundingBox.y - icon.absoluteBoundingBox.y
 * 这样就不需要矩阵乘法，也不会引入 NaN。
 */
function buildSvgFromNode(iconNode) {
  const bb = iconNode.absoluteBoundingBox
  if (!bb) return null
  const { x: ox, y: oy, width: w, height: h } = bb

  const leaves = collectVectorLeaves(iconNode)
  if (leaves.length === 0) return null

  const paths = []
  for (const node of leaves) {
    const geos = node.fillGeometry || []
    const fills = (node.fills || []).filter(f => f.type === 'SOLID' && f.visible !== false)
    const fill = fills[0]
    if (!fill) continue // 无可见 fill 的路径（点击区域等）跳过
    const color = figmaColorToHex(fill.color)
    const opacityAttr = fill.opacity != null && fill.opacity < 1
      ? ` opacity="${fill.opacity.toFixed(3)}"` : ''

    // 用 absoluteBoundingBox 差值定位，不依赖矩阵乘法
    const nbb = node.absoluteBoundingBox
    const dx = nbb ? +(nbb.x - ox).toFixed(4) : 0
    const dy = nbb ? +(nbb.y - oy).toFixed(4) : 0
    const transformStr = (dx !== 0 || dy !== 0) ? ` transform="translate(${dx},${dy})"` : ''

    for (const geo of geos) {
      if (!geo.path) continue
      paths.push(`  <path d="${geo.path}" fill="${color}"${opacityAttr}${transformStr}/>`)
    }
  }

  if (paths.length === 0) return null

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="none">`,
    ...paths,
    '</svg>',
  ].join('\n')
}

/** 从节点树里按 id 查找节点 */
function findNodeById(root, targetId) {
  if (root.id === targetId) return root
  if (root.children) {
    for (const c of root.children) {
      const found = findNodeById(c, targetId)
      if (found) return found
    }
  }
  return null
}

/** 递归检测节点树中是否含有外部库 INSTANCE（子树中存在即为真）。
 *  外部库 INSTANCE 的 fillGeometry 只是边界框，本地合成 SVG 会产生空壳，必须走 API 或手动导出。 */
function hasExternalInstance(node, fileComponents) {
  if (node.type === 'INSTANCE' && node.componentId && !(node.componentId in fileComponents)) {
    return true
  }
  for (const c of node.children || []) {
    if (hasExternalInstance(c, fileComponents)) return true
  }
  return false
}

function buildIconsSvgLocally(icons, rootNode, fileComponents, iconsDir) {
  if (icons.length === 0) return []
  mkdirSync(iconsDir, { recursive: true })

  return icons.map(ic => {
    const safeName = ic.name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '-')
    const filePath = join(iconsDir, `${safeName}.svg`)
    const iconNode = findNodeById(rootNode, ic.id)
    if (!iconNode) return { ...ic, file: null, note: 'needs-api' }

    // 节点自身或任意子节点含外部库 INSTANCE → 本地合成会产生空壳，走 API 或手动导出
    if (hasExternalInstance(iconNode, fileComponents)) {
      return { ...ic, file: null, note: 'needs-api' }
    }

    const svg = buildSvgFromNode(iconNode)
    if (!svg) return { ...ic, file: null, note: 'needs-api' }

    writeFileSync(filePath, svg, 'utf8')
    return { ...ic, file: `icons/${safeName}.svg`, note: 'ok (本地合成)' }
  })
}

// ---------- API 回退导出（用于本地合成失败的外部库图标）----------
async function exportIconsViaApi(fileKey, icons, token, iconsDir) {
  if (icons.length === 0) return []
  mkdirSync(iconsDir, { recursive: true })

  console.log(`   🌐 ${icons.length} 个图标无法本地合成，尝试 API 导出...`)

  const results = []
  const BATCH = 50
  for (let i = 0; i < icons.length; i += BATCH) {
    if (i > 0) await sleep(1500)
    const batch = icons.slice(i, i + BATCH)
    const idsParam = batch.map(ic => encodeURIComponent(ic.id)).join('%2C')
    const url = `https://api.figma.com/v1/images/${fileKey}?ids=${idsParam}&format=svg`

    let data
    try {
      // 单次尝试，不重试 429——让用户决定是等还是手动导出
      const res = await fetch(url, { headers: { 'X-Figma-Token': token } })
      if (res.status === 429) {
        // 429：打印手动导出提示，跳过整批
        console.warn('\n   ⚠️  Figma API 限流(429)，以下图标请手动从 Figma 导出：')
        for (const ic of batch) {
          const safeName = ic.name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '-')
          const nodeIdSafe = ic.id.replace(/[:/;]/g, '-')
          console.warn(`      节点 ID: ${ic.id}`)
          console.warn(`      图标名称: ${ic.name}  (${ic.size?.w}x${ic.size?.h})`)
          console.warn(`      操作：Figma 中选中该图层 → 右键 → Copy/Paste as → Copy as SVG`)
          console.warn(`      保存到：.figma/${nodeIdSafe}/icons/${safeName}.svg\n`)
          results.push({ ...ic, file: null, note: '⚠ API 限流，请手动从 Figma 导出' })
        }
        continue
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Figma API ${res.status}: ${body}`)
      }
      data = await res.json()
    } catch (err) {
      for (const ic of batch) {
        results.push({ ...ic, file: null, note: `API 错误: ${err.message}` })
      }
      continue
    }

    const imgMap = data.images || {}
    for (const ic of batch) {
      const svgUrl = imgMap[ic.id]
      if (!svgUrl) {
        results.push({ ...ic, file: null, note: 'API 返回 null（外部库组件，无法导出）' })
        continue
      }
      const safeName = ic.name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '-')
      const filePath = join(iconsDir, `${safeName}.svg`)
      await downloadBinary(svgUrl, filePath)
      results.push({ ...ic, file: `icons/${safeName}.svg`, note: 'ok (API 导出)' })
      console.log(`   ✅ ${ic.name} → icons/${safeName}.svg`)
    }
  }
  return results
}

// ---------- 打印报告 ----------
function printReport(report) {
  const { bitmaps, icons, texts } = report

  console.log('\n  ┌─ 资源分类报告 ─────────────────────────────')

  console.log(`  │ 📷 位图 (${bitmaps.length} 个)`)
  if (bitmaps.length === 0) {
    console.log('  │    (无)')
  } else {
    bitmaps.forEach(b =>
      console.log(`  │    [${b.type}] ${b.name}  ${b.size?.w}x${b.size?.h}  ref=${b.imageRef}`)
    )
  }

  console.log(`  │ 🎨 矢量图标 (${icons.length} 个，已去重)`)
  if (icons.length === 0) {
    console.log('  │    (无)')
  } else {
    icons.forEach(ic => {
      const fileNote = ic.file ? `→ ${ic.file}` : `⚠ ${ic.note}`
      console.log(`  │    [${ic.type}] ${ic.name}  ${ic.size?.w}x${ic.size?.h}  ${fileNote}`)
    })
  }

  console.log(`  │ 📝 文本 (${texts.length} 个)`)
  texts.forEach(t =>
    console.log(
      `  │    "${t.characters}"  ${t.fontSize}px/${t.fontWeight}  ${t.fills[0] ?? ''}  ${t.size?.w}x${t.size?.h}`
    )
  )

  console.log('  └────────────────────────────────────────────')
}

// ---------- 主流程 ----------
async function fetchNode(fileKey, nodeIdColon, token) {
  // nodeIdColon 已是 API 格式（含 :）
  const safeDirName = nodeIdColon.replace(/:/g, '-')
  const outDir = join(CACHE_DIR, safeDirName)
  const assetsDir = join(outDir, 'assets')
  const iconsDir = join(outDir, 'icons')
  mkdirSync(assetsDir, { recursive: true })

  console.log(`\n── node ${nodeIdColon} ──────────────────────────────`)

  const BASE_URL = 'https://api.figma.com'
  const nodeJsonPath = join(outDir, 'node.json')
  const renderPath = join(outDir, 'render@2x.png')

  // 1. 图层 JSON（有缓存则跳过）
  let nodesData
  if (existsSync(nodeJsonPath)) {
    console.log('① node.json（缓存命中，跳过请求）')
    nodesData = JSON.parse(readFileSync(nodeJsonPath, 'utf8'))
  } else {
    console.log('① 拉取图层 JSON ...')
    const nodesUrl = `${BASE_URL}/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeIdColon)}&geometry=paths`
    nodesData = await apiFetch(nodesUrl, token)
    writeFileSync(nodeJsonPath, JSON.stringify(nodesData, null, 2), 'utf8')
    console.log('   ✅ node.json')
  }

  const nodeMap = nodesData.nodes || {}
  const nodeEntry = nodeMap[nodeIdColon] || Object.values(nodeMap)[0]
  const rootNode = nodeEntry?.document
  const fileComponents = nodesData.components || {}

  // 2. 整屏渲染图（有缓存则跳过）
  if (existsSync(renderPath)) {
    console.log('② render@2x.png（缓存命中，跳过请求）')
  } else {
    console.log('② 渲染图 ...')
    try {
      const imgData = await apiFetch(
        `${BASE_URL}/v1/images/${fileKey}?ids=${encodeURIComponent(nodeIdColon)}&format=png&scale=2`,
        token
      )
      const renderUrl = (imgData.images || {})[nodeIdColon] || Object.values(imgData.images || {})[0]
      if (renderUrl) {
        await downloadBinary(renderUrl, renderPath)
        console.log('   ✅ render@2x.png')
      } else {
        console.warn('   ⚠️  未获取到渲染图 URL（跳过，不影响图层分析）')
      }
    } catch (e) {
      console.warn(`   ⚠️  渲染图获取失败（${e.message}），跳过。可稍后重试或在 Figma 手动导出 PNG。`)
    }
  }

  if (!rootNode) {
    console.warn('   ⚠️  rootNode 为空，跳过分析')
    return { outDir, rootNode: null }
  }

  // 3. 分析资源
  console.log('③ 分析资源类型 ...')
  const { bitmaps, icons: rawIcons, texts } = analyzeNode(rootNode)
  const icons = dedupeIcons(rawIcons)

  // 3a. 下载位图素材（已存在的跳过）
  if (bitmaps.length > 0) {
    // 按来源分两类：有 imageRef 的走 /files/{key}/images（内嵌图片）；无 imageRef 的走渲染 API
    const withRef    = bitmaps.filter(b => b.imageRef)
    const withoutRef = bitmaps.filter(b => !b.imageRef)

    // ① 有 imageRef：批量取 CDN URL 再下载
    const missingWithRef = withRef.filter(b => !existsSync(join(assetsDir, `${b.imageRef}.png`)))
    const cachedWithRef  = withRef.length - missingWithRef.length
    if (cachedWithRef > 0) console.log(`   ${cachedWithRef} 个位图命中缓存，跳过`)
    if (missingWithRef.length > 0) {
      const allImagesData = await apiFetch(`${BASE_URL}/v1/files/${fileKey}/images`, token)
      const refMap = allImagesData.meta?.images || {}
      for (const b of missingWithRef) {
        const url = refMap[b.imageRef]
        if (!url) { console.warn(`   ⚠️  imageRef ${b.imageRef} 无 URL`); continue }
        await downloadBinary(url, join(assetsDir, `${b.imageRef}.png`))
        console.log(`   ✅ assets/${b.imageRef}.png`)
      }
    }

    // ② 无 imageRef（exportSettings 标记的位图）：走渲染 API
    for (const b of withoutRef) {
      const safeName = b.name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '-')
      const ext = (b.exportFormat || 'PNG').toLowerCase()
      const filePath = join(assetsDir, `${safeName}.${ext}`)
      if (existsSync(filePath)) {
        console.log(`   ${safeName}.${ext}（缓存命中，跳过）`)
        continue
      }
      try {
        const imgData = await apiFetch(
          `${BASE_URL}/v1/images/${fileKey}?ids=${encodeURIComponent(b.id)}&format=${ext}&scale=2`,
          token
        )
        const renderUrl = (imgData.images || {})[b.id]
        if (renderUrl) {
          await downloadBinary(renderUrl, filePath)
          console.log(`   ✅ assets/${safeName}.${ext}`)
        } else {
          console.warn(`   ⚠️  ${b.name} 无渲染 URL`)
        }
      } catch (e) {
        console.warn(`   ⚠️  ${b.name} 渲染失败（${e.message}），跳过`)
      }
    }
  }

  // 3b. 图标导出：先本地合成，失败的回退到 API，API 429 时提示手动导出
  const cachedIcons = []
  const uncachedIcons = []
  for (const ic of icons) {
    const safeName = ic.name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '-')
    if (existsSync(join(iconsDir, `${safeName}.svg`))) {
      cachedIcons.push({ ...ic, file: `icons/${safeName}.svg`, note: 'cached' })
    } else {
      uncachedIcons.push(ic)
    }
  }
  if (cachedIcons.length > 0) console.log(`   ${cachedIcons.length} 个图标命中缓存，跳过`)

  // 先本地合成（外部库 INSTANCE 会被标记为 needs-api）
  const localResults = buildIconsSvgLocally(uncachedIcons, rootNode, fileComponents, iconsDir)

  // 对本地合成失败的（note !== 'ok (本地合成)'）回退 API 导出
  const needsApi = localResults.filter(r => r.note !== 'ok (本地合成)')
  const apiResults = needsApi.length > 0
    ? await exportIconsViaApi(fileKey, needsApi, token, iconsDir)
    : []

  // 合并：cached + 本地合成成功 + API 结果
  const localOk = localResults.filter(r => r.note === 'ok (本地合成)')
  const iconResults = [...cachedIcons, ...localOk, ...apiResults]

  // 补充文件路径到 bitmaps（便于 report.json）：
  // 有 imageRef 的落 assets/<ref>.png；exportSettings 位图（imageRef=null）落 assets/<safeName>.<ext>，
  // 与 3a 段实际下载文件名保持一致。
  const bitmapsWithFile = bitmaps.map(b => {
    if (b.imageRef) return { ...b, file: `assets/${b.imageRef}.png` }
    const safeName = b.name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '-')
    const ext = (b.exportFormat || 'PNG').toLowerCase()
    return { ...b, file: `assets/${safeName}.${ext}` }
  })

  // 4. 写 report.json
  const report = {
    nodeId: nodeIdColon,
    bitmaps: bitmapsWithFile,
    icons: iconResults,
    texts,
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log('   ✅ report.json')

  printReport({ bitmaps: bitmapsWithFile, icons: iconResults, texts })

  return { outDir, rootNode }
}

// ---------- --inspect：系统性数据核对（纯读缓存 node.json，不发请求/不需 token）----------

/** 把 nodeId（短横/冒号）或 Figma 链接统一解析成冒号格式 nodeId */
function resolveNodeId(arg) {
  if (arg.startsWith('http') || arg.includes('figma.com')) {
    const p = parseFigmaUrl(arg)
    return p ? p.nodeId : null
  }
  return arg.replace(/-/g, ':')
}

/**
 * 遍历 node.json 子树，dump 所有「可见」节点的几何/文本/样式，供逐项对照实现。
 * 关键：第一行就过滤 visible:false——隐藏的备用态/占位节点带完整 box/fills，
 * 漏过滤会把它们误当成「设计稿有这个元素」（反复栽的坑，故机制化到脚本里）。
 */
function dumpVisible(n, depth = 0) {
  if (n.visible === false) return
  const pad = '  '.repeat(depth)
  const hex = c =>
    '#' + [c.r, c.g, c.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
  const b = n.absoluteBoundingBox
  if (n.type === 'TEXT') {
    const col = (n.fills || []).filter(f => f.type === 'SOLID').map(f => hex(f.color))[0] || ''
    const s = n.style || {}
    console.log(`${pad}TXT "${n.characters}" ${s.fontSize}px/${s.fontWeight} lh${Math.round(s.lineHeightPx || 0)} ${col}`)
  } else if (['FRAME', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET', 'RECTANGLE', 'GROUP'].includes(n.type) && b) {
    const solid = (n.fills || []).filter(f => f.type === 'SOLID').map(f => hex(f.color))
    const stroke = (n.strokes || []).filter(s => s.type === 'SOLID').map(s => hex(s.color))
    const parts = [`[${n.type}] ${n.name}`, `${Math.round(b.width)}x${Math.round(b.height)}`]
    if (n.layoutMode) parts.push(`${n.layoutMode[0]}gap${n.itemSpacing || 0}`)
    if (n.paddingLeft != null || n.paddingTop != null)
      parts.push(`pad${n.paddingTop || 0}/${n.paddingRight || 0}/${n.paddingBottom || 0}/${n.paddingLeft || 0}`)
    if (n.cornerRadius) parts.push(`r${n.cornerRadius}`)
    if (solid.length) parts.push(`bg${solid}`)
    if (stroke.length) parts.push(`bd${stroke}@${n.strokeWeight}`)
    console.log(pad + parts.join(' '))
  }
  for (const c of n.children || []) dumpVisible(c, depth + 1)
}

function inspectNode(rawArg) {
  const nodeId = resolveNodeId(rawArg)
  if (!nodeId) {
    console.error(`❌ 无法解析 nodeId：${rawArg}`)
    process.exit(1)
  }
  const safeDirName = nodeId.replace(/:/g, '-')
  const nodeJsonPath = join(CACHE_DIR, safeDirName, 'node.json')
  if (!existsSync(nodeJsonPath)) {
    console.error(`❌ 找不到 ${nodeJsonPath}`)
    console.error('   请先取数：node figma-fetch.mjs "<Figma 链接>"')
    process.exit(1)
  }
  const data = JSON.parse(readFileSync(nodeJsonPath, 'utf8'))
  const rootNode = (data.nodes?.[nodeId] || Object.values(data.nodes || {})[0])?.document
  if (!rootNode) {
    console.error('❌ node.json 里没有 document 节点')
    process.exit(1)
  }
  console.log(`\n── inspect ${nodeId}（仅 visible 节点，用于逐项对照实现）──────────`)
  dumpVisible(rootNode)
}

// ---------- 入口 ----------
const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('用法（推荐）：node figma-fetch.mjs "<Figma 链接>" ["<链接2>" ...]')
  console.error('用法（兼容）：node figma-fetch.mjs <fileKey> <nodeId> [nodeId2 ...]')
  console.error('数据核对：  node figma-fetch.mjs --inspect "<Figma 链接或 nodeId>"')
  process.exit(1)
}

// --inspect：纯读已缓存的 node.json，dump 全树可见节点做系统性数据核对，不发请求、不需 token
if (args[0] === '--inspect') {
  if (!args[1]) {
    console.error('用法：node figma-fetch.mjs --inspect "<Figma 链接或 nodeId（如 2004-2684）>"')
    process.exit(1)
  }
  inspectNode(args[1])
  process.exit(0)
}

const token = loadToken()

// 判断是否为链接模式（第一个参数含 figma.com 或以 http 开头）
const isUrlMode = args[0].startsWith('http') || args[0].includes('figma.com')

let tasks // [{fileKey, nodeId}]

if (isUrlMode) {
  tasks = []
  for (const arg of args) {
    const parsed = parseFigmaUrl(arg)
    if (!parsed) {
      console.error(`❌ 无法解析为 Figma 链接：${arg}`)
      console.error('   期望格式：https://www.figma.com/design/<fileKey>/...?node-id=xxxx-xxxx')
      process.exit(1)
    }
    tasks.push(parsed)
  }
} else {
  // 旧式：<fileKey> <nodeId> [nodeId2 ...]
  if (args.length < 2) {
    console.error('旧式用法需要至少两个参数：node figma-fetch.mjs <fileKey> <nodeId>')
    process.exit(1)
  }
  const [fileKey, ...nodeIds] = args
  tasks = nodeIds.map(rawId => ({
    fileKey,
    nodeId: rawId.replace(/-/g, ':'),
  }))
}

console.log(`节点数量: ${tasks.length}`)

for (const { fileKey, nodeId } of tasks) {
  console.log(`文件 key: ${fileKey}`)
  await fetchNode(fileKey, nodeId, token)
}

console.log('\n✅ 全部完成。产物在 .figma/ 目录（请确保已加入 .gitignore）。')
