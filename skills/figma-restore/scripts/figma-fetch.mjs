/**
 * 简单的 Figma 下载工具：保存 nodes，并尽力下载 render、位图和 SVG。
 * 资源失败只进入 report.json 的手动清单；nodes 失败才以非零退出。
 */
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join, resolve, relative, sep } from 'path'
import http from 'http'
import https from 'https'

const API = process.env.FIGMA_API_BASE_URL || 'https://api.figma.com'
const CWD = process.cwd()

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function sanitizeName(value) {
  return String(value == null ? '' : value).replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '-')
}

function sanitizeNodeId(value) {
  return String(value == null ? '' : value).replace(/[:/;]/g, '-')
}

function parseFigmaUrl(value) {
  let url
  try { url = new URL(value) } catch { return null }
  if (!url.hostname.endsWith('figma.com')) return null
  const parts = url.pathname.split('/').filter(Boolean)
  const index = parts.findIndex(part => ['design', 'file', 'proto'].includes(part))
  const nodeId = url.searchParams.get('node-id')
  if (index < 0 || !parts[index + 1] || !nodeId) return null
  return { fileKey: decodeURIComponent(parts[index + 1]), nodeId: nodeId.replace(/-/g, ':') }
}

function cacheRelPath(fileKey, nodeId) {
  return join('.figma', sanitizeName(fileKey), sanitizeNodeId(nodeId))
}

function validateCachePart(value, name) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\]/.test(value)) {
    throw new Error(`危险${name}，拒绝操作`)
  }
}

function cacheDir(baseDir, fileKey, nodeId) {
  validateCachePart(fileKey, 'fileKey')
  validateCachePart(nodeId, 'nodeId')
  const figmaDir = resolve(baseDir, '.figma')
  const outDir = resolve(baseDir, cacheRelPath(fileKey, nodeId))
  const outRelative = relative(figmaDir, outDir)
  if (!outRelative || outRelative === '..' || outRelative.startsWith(`..${sep}`) || outRelative.startsWith(sep)) {
    throw new Error('缓存目录越界，拒绝操作')
  }
  return outDir
}

function validNodeData(data, nodeId) {
  const document = data?.nodes?.[nodeId]?.document
  return !!(document && typeof document === 'object')
}

function fetchCompat(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = (url.startsWith('https:') ? https : http).request(url, {
      method: options.method || 'GET', headers: options.headers || {},
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const body = Buffer.concat(chunks)
        resolve({
          status: response.statusCode,
          ok: response.statusCode >= 200 && response.statusCode < 300,
          headers: { get: name => response.headers[name.toLowerCase()] || null },
          text: async () => body.toString('utf8'),
          json: async () => JSON.parse(body.toString('utf8')),
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        })
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

async function apiFetch(url, token, fetcher = fetchCompat) {
  const response = await fetcher(url, { headers: { 'X-Figma-Token': token } })
  if (!response.ok) throw new Error(`Figma API ${response.status}`)
  return response.json()
}

async function download(url, filePath, fetcher = fetchCompat) {
  if (!url) throw new Error('无 URL')
  const response = await fetcher(url)
  if (!response.ok) throw new Error(`下载失败 ${response.status}`)
  const body = Buffer.from(await response.arrayBuffer())
  if (!body.length) throw new Error('下载失败：空响应')
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, body)
}

function sizeOf(node) {
  const box = node.absoluteBoundingBox
  return box ? { w: Math.round(box.width), h: Math.round(box.height) } : null
}

function bitmapTarget(bitmap) {
  if (bitmap.imageRef) return `assets/${sanitizeName(bitmap.imageRef)}.png`
  return `assets/${sanitizeName(bitmap.name)}__${sanitizeNodeId(bitmap.id)}.${String(bitmap.format || 'PNG').toLowerCase()}`
}

function iconTarget(icon) {
  return `icons/${sanitizeName(icon.name)}__${sanitizeNodeId(icon.id)}.svg`
}

function analyzeNode(node, bitmaps = [], icons = [], texts = []) {
  if (!node || node.visible === false) return { bitmaps, icons, texts }
  for (const fill of node.fills || []) {
    if (fill.type === 'IMAGE' && fill.imageRef) {
      bitmaps.push({ id: node.id, name: node.name, type: node.type, imageRef: fill.imageRef, size: sizeOf(node) })
    }
  }
  const exportSettings = node.exportSettings || []
  const bitmapExport = exportSettings.find(item => ['PNG', 'JPG', 'JPEG', 'WEBP'].includes(item.format))
  if (bitmapExport && node.type !== 'DOCUMENT' && !bitmaps.some(item => item.id === node.id)) {
    bitmaps.push({ id: node.id, name: node.name, type: node.type, imageRef: null, format: bitmapExport.format, size: sizeOf(node) })
  }
  if (node.type === 'TEXT') texts.push({ id: node.id, name: node.name, characters: node.characters, size: sizeOf(node) })
  if (exportSettings.some(item => item.format === 'SVG')) {
    icons.push({ id: node.id, name: node.name, type: node.type, size: sizeOf(node) })
  }
  for (const child of node.children || []) analyzeNode(child, bitmaps, icons, texts)
  return { bitmaps, icons, texts }
}

function manual(entry, target, note) {
  return { ...entry, file: null, target, note: `${note}；请手动获取` }
}

async function fetchNode(fileKey, nodeId, token, { baseDir = CWD, fetcher = fetchCompat } = {}) {
  const outDir = cacheDir(baseDir, fileKey, nodeId)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const nodesUrl = `${API}/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`
  let data
  try {
    const cached = join(outDir, 'node.json')
    data = await apiFetch(nodesUrl, token, fetcher)
    if (!validNodeData(data, nodeId)) throw new Error('nodes 响应无目标 document')
    writeFileSync(cached, JSON.stringify(data, null, 2))
  } catch (error) {
    throw new Error(`nodes 获取失败：${safeErrorMessage(error)}`)
  }

  const root = data.nodes[nodeId].document
  const { bitmaps, icons, texts } = analyzeNode(root)
  const report = { fileKey, nodeId, render: null, bitmaps: [], icons: icons.map(icon => ({ ...icon, file: null })), texts }
  const renderTarget = 'render@2x.png'
  try {
    const result = await apiFetch(`${API}/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png&scale=2`, token, fetcher)
    const url = result?.images?.[nodeId]
    if (!url) throw new Error('无 URL')
    await download(url, join(outDir, renderTarget), fetcher)
    report.render = { file: renderTarget, target: renderTarget, note: 'ok' }
  } catch (error) {
    report.render = manual({}, renderTarget, `render 失败：${safeErrorMessage(error)}`)
  }

  let imageUrls = {}
  try {
    const result = await apiFetch(`${API}/v1/files/${encodeURIComponent(fileKey)}/images`, token, fetcher)
    imageUrls = result?.meta?.images || {}
  } catch (error) {
    for (const bitmap of bitmaps.filter(item => item.imageRef)) {
      report.bitmaps.push(manual(bitmap, bitmapTarget(bitmap), `位图 API 失败：${safeErrorMessage(error)}`))
    }
  }
  for (const bitmap of bitmaps) {
    if (report.bitmaps.some(item => item.id === bitmap.id)) continue
    let url = bitmap.imageRef ? imageUrls[bitmap.imageRef] : null
    let target = bitmapTarget(bitmap)
    try {
      if (!bitmap.imageRef) {
        const result = await apiFetch(`${API}/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(bitmap.id)}&format=${String(bitmap.format || 'PNG').toLowerCase()}`, token, fetcher)
        url = result?.images?.[bitmap.id]
      }
      if (!url) throw new Error(bitmap.imageRef ? '无 URL' : '无渲染 URL')
      await download(url, join(outDir, target), fetcher)
      report.bitmaps.push({ ...bitmap, file: target, target, note: 'ok' })
    } catch (error) {
      report.bitmaps.push(manual(bitmap, target, `位图失败：${safeErrorMessage(error)}`))
    }
  }

  for (const icon of icons) {
    const target = iconTarget(icon)
    try {
      const result = await apiFetch(`${API}/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(icon.id)}&format=svg`, token, fetcher)
      const url = result?.images?.[icon.id]
      if (!url) throw new Error('无 URL')
      await download(url, join(outDir, target), fetcher)
      const item = report.icons.find(entry => entry.id === icon.id)
      Object.assign(item, { file: target, target, note: 'ok' })
    } catch (error) {
      const item = report.icons.find(entry => entry.id === icon.id)
      Object.assign(item, manual(icon, target, `SVG 失败：${safeErrorMessage(error)}`))
    }
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  return { report, hadResourceFailure: JSON.stringify(report).includes('请手动获取') }
}

function parseCliArgs(args) {
  if (args.includes('--data-only')) throw new Error('--data-only 不支持')
  if (args.includes('--inspect')) throw new Error('--inspect 不支持')
  if (args.length === 0 || args.includes('--help')) return { mode: 'help' }
  if (args.length === 2 && !args[0].startsWith('http')) return { mode: 'legacy', tasks: [{ fileKey: args[0], nodeId: args[1].replace(/-/g, ':') }] }
  const tasks = args.map(value => parseFigmaUrl(value)).filter(Boolean)
  if (tasks.length !== args.length) throw new Error('需要 Figma 链接或 fileKey nodeId')
  return { mode: 'urls', tasks }
}

function printHelp() {
  console.log('用法：node figma-fetch.mjs "Figma 链接" 或 node figma-fetch.mjs <fileKey> <nodeId>')
  console.log('nodes 失败退出非零；render、位图、SVG 失败写入 report.json 并请手动获取。')
}

export { parseFigmaUrl, parseCliArgs, sanitizeName, sanitizeNodeId, bitmapTarget, iconTarget, fetchCompat, apiFetch, download, analyzeNode, fetchNode }

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const parsed = parseCliArgs(process.argv.slice(2))
    if (parsed.mode === 'help') printHelp()
    else {
      const token = process.env.FIGMA_TOKEN
      if (!token) throw new Error('缺少 FIGMA_TOKEN')
      for (const task of parsed.tasks) await fetchNode(task.fileKey, task.nodeId, token)
      console.log('完成；失败资源请按 report.json 的 target 手动获取。')
    }
  } catch (error) {
    console.error(`失败：${safeErrorMessage(error)}`)
    process.exitCode = 1
  }
}
