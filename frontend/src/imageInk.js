// Where an embedded image actually has "ink" - the pixels a laser would engrave.
//
// The Epilog driver engraves ANY image as a raster, in colour or not: it turns
// it into grayscale (darker = more burn) and the head sweeps each scan row from
// the first to the last pixel that fires, exactly like a filled shape
// (toolpath.js rasterScanRows). White and fully transparent pixels never fire.
// ASSUMPTION, not measured yet: that images are timed exactly like filled
// shapes of the same outline. A vector square vs. the same square as a gray and
// as a colour PNG on the machine would settle it.
//
// Pixels are only available asynchronously (the image has to decode), and
// buildToolpath is synchronous, so the analysis runs once per image, is cached by
// its data URL (rotating/moving an image keeps the same pixels), and the viewer
// rebuilds the toolpath when it lands. Until then an image counts with its whole
// rectangle - the conservative fallback.

// A pixel counts as ink below this luminance (after compositing its alpha over
// white). Not 1.0: JPEG noise leaves "white" backgrounds at 250-254, which would
// otherwise make every row of a photo's white margin count.
const INK_LUM = 0.97
// A pixel counts as coloured when its channels spread more than this (same idea
// as GRAY_TOL in toolpath.js); an image is "coloured" from 1 % of its ink on.
const COLOR_SPREAD = 0.12
const COLORED_SHARE = 0.01
// Large photos are analysed at a reduced size - far finer than any scan pitch.
const MAX_SIDE = 4096

const cache = new Map()   // data URL -> ink | Promise

// ink = { w, h, rowX0, rowX1, colY0, colY1, colored, empty }: per pixel row the
// first/last ink column (-1 = none), per pixel column the first/last ink row.
export function getImageInk(obj) {
  const v = obj && obj.data ? cache.get(obj.data) : null
  return v && !(v instanceof Promise) ? v : null
}

// Analyses every image in `data` that isn't cached yet. Resolves to true if at
// least one new result arrived (the caller then rebuilds its toolpath).
export async function ensureImageInk(data) {
  const todo = []
  for (const o of data || []) {
    if (o.type !== 'img' || !o.data) continue
    if (!cache.has(o.data)) cache.set(o.data, analyse(o.data))
    const v = cache.get(o.data)
    if (v instanceof Promise) todo.push(v)
  }
  if (!todo.length) return false
  await Promise.all(todo)
  return true
}

// onload, not img.decode(): decode() waits for a rendering opportunity and never
// settles while the page isn't being drawn (tab in the background, pane
// hidden) - the analysis then silently never landed.
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image could not be loaded'))
    img.src = url
  })
}

async function analyse(url) {
  try {
    const img = await loadImage(url)
    const s = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * s))
    const h = Math.max(1, Math.round(img.naturalHeight * s))
    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0, w, h)
    const px = ctx.getImageData(0, 0, w, h).data

    const rowX0 = new Int32Array(h).fill(-1), rowX1 = new Int32Array(h).fill(-1)
    const colY0 = new Int32Array(w).fill(-1), colY1 = new Int32Array(w).fill(-1)
    let inkCount = 0, colorCount = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const a = px[i + 3] / 255
        const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255
        const lum = 1 - a * (1 - (0.299 * r + 0.587 * g + 0.114 * b))   // over white
        if (lum >= INK_LUM) continue
        inkCount++
        if (Math.max(r, g, b) - Math.min(r, g, b) > COLOR_SPREAD) colorCount++
        if (rowX0[y] < 0) rowX0[y] = x
        rowX1[y] = x
        if (colY0[x] < 0) colY0[x] = y
        colY1[x] = y
      }
    }
    const ink = { w, h, rowX0, rowX1, colY0, colY1, empty: inkCount === 0,
                  colored: inkCount > 0 && colorCount / inkCount >= COLORED_SHARE }
    cache.set(url, ink)
    return ink
  } catch (e) {
    console.warn('[imageInk] analysis failed, counting the whole image:', e)
    cache.delete(url)
    return null
  }
}

// Grayscale version of an image as the laser sees it (luminance, alpha kept),
// for the "Bilder wie der Laser" view. Cached; resolves to a data URL.
const grayCache = new Map()
export function grayImageUrl(url) {
  if (!grayCache.has(url)) grayCache.set(url, toGray(url))
  return grayCache.get(url)
}

async function toGray(url) {
  const img = await loadImage(url)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const px = d.data
  for (let i = 0; i < px.length; i += 4) {
    const l = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2])
    px[i] = px[i + 1] = px[i + 2] = l
  }
  ctx.putImageData(d, 0, 0)
  return canvas.toDataURL('image/png')
}
