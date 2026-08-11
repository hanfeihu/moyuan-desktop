import * as React from 'react'
import { Copy, ImagePlus, Layers, Loader2, Move, RotateCcw, RotateCw, Save, Trash2, Upload, X } from 'lucide-react'
import { runtimeEndpoint } from '../../api'

// 远程 http(s) 图片经 runtime 代理加载，规避媒体服务器重复 CORS 头导致的 canvas 污染；
// dataURL / blob / 本地图直接用。
function proxiedImageUrl(url: string) {
  if (/^https?:\/\//i.test(url)) {
    return runtimeEndpoint(`/api/image-proxy?url=${encodeURIComponent(url)}`)
  }
  return url
}

type MaskBox = {
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
}

type MaskLayer = {
  id: string
  name: string
  image: HTMLImageElement
  box: MaskBox
}

function defaultMaskUrl() {
  const c = document.createElement('canvas')
  c.width = 720
  c.height = 480
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, c.width, c.height)
  ctx.strokeStyle = 'rgba(70, 70, 70, 0.68)'
  ctx.lineWidth = 8
  ctx.lineCap = 'round'

  const verticals = [180, 305, 375, 470]
  verticals.forEach((x, i) => {
    ctx.beginPath()
    ctx.moveTo(x + (i === 1 ? -10 : 0), 30)
    ctx.lineTo(x + (i === 3 ? -8 : 0), 450)
    ctx.stroke()
  })

  const horizontals: Array<[number, number, number]> = [
    [95, 105, 560],
    [150, 88, 620],
    [190, 80, 610],
    [245, 74, 650],
    [315, 65, 700],
    [385, 84, 675],
  ]
  horizontals.forEach(([y, x1, x2], i) => {
    ctx.beginPath()
    ctx.moveTo(x1, y + (i % 2 ? 3 : -2))
    ctx.lineTo(x2, y - (i === 5 ? -12 : 0))
    ctx.stroke()
  })

  return c.toDataURL('image/png')
}

function loadImage(src: string, crossOrigin = false) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    if (crossOrigin) img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

async function transparentizeMask(file: File) {
  const src = URL.createObjectURL(file)
  try {
    const img = await loadImage(src)
    const c = document.createElement('canvas')
    c.width = img.naturalWidth || img.width
    c.height = img.naturalHeight || img.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0, c.width, c.height)
    const data = ctx.getImageData(0, 0, c.width, c.height)
    for (let i = 0; i < data.data.length; i += 4) {
      const r = data.data[i]
      const g = data.data[i + 1]
      const b = data.data[i + 2]
      if (r > 235 && g > 235 && b > 235) data.data[i + 3] = 0
    }
    ctx.putImageData(data, 0, 0)
    return c.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(src)
  }
}

function layerId() {
  return globalThis.crypto?.randomUUID?.() ?? `mask-${Math.random().toString(16).slice(2)}`
}

function createLayer(mask: HTMLImageElement, baseImage: HTMLImageElement, index: number, offset = 0): MaskLayer {
  const iw = baseImage.naturalWidth || baseImage.width
  const ih = baseImage.naturalHeight || baseImage.height
  const mw = Math.round(iw * 0.28)
  const mh = Math.round(mw * ((mask.naturalHeight || mask.height) / (mask.naturalWidth || mask.width)))
  return {
    id: layerId(),
    name: `遮罩 ${index}`,
    image: mask,
    box: {
      x: Math.max(0, Math.round((iw - mw) / 2 + offset)),
      y: Math.max(0, Math.round((ih - mh) / 2 + offset)),
      width: mw,
      height: mh,
      rotation: 0,
      opacity: 0.9,
    },
  }
}

function drawImageWithMasks(canvas: HTMLCanvasElement, image: HTMLImageElement, layers: MaskLayer[]) {
  const w = image.naturalWidth || image.width
  const h = image.naturalHeight || image.height
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(image, 0, 0, w, h)

  for (const layer of layers) {
    const box = layer.box
    ctx.save()
    ctx.globalAlpha = box.opacity
    ctx.translate(box.x + box.width / 2, box.y + box.height / 2)
    ctx.rotate((box.rotation * Math.PI) / 180)
    ctx.drawImage(layer.image, -box.width / 2, -box.height / 2, box.width, box.height)
    ctx.restore()
  }
}

export function FaceMaskEditor({
  open,
  imageUrl,
  title,
  onClose,
  onSave,
}: {
  open: boolean
  imageUrl: string
  title: string
  onClose: () => void
  onSave: (dataUrl: string) => void | Promise<void>
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const maskInputRef = React.useRef<HTMLInputElement>(null)
  const dragRef = React.useRef<{ layerId: string; dx: number; dy: number } | null>(null)
  const [image, setImage] = React.useState<HTMLImageElement | null>(null)
  const [layers, setLayers] = React.useState<MaskLayer[]>([])
  const [activeLayerId, setActiveLayerId] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open || !imageUrl) return
    let cancelled = false
    setImage(null)
    setLayers([])
    setActiveLayerId(null)
    setError('')
    setSaving(false)
    Promise.all([loadImage(proxiedImageUrl(imageUrl), true), loadImage(defaultMaskUrl())])
      .then(([img, maskImg]) => {
        if (cancelled) return
        const first = createLayer(maskImg, img, 1)
        setImage(img)
        setLayers([first])
        setActiveLayerId(first.id)
      })
      .catch(() => {
        if (!cancelled) setError('图片加载失败，可能是跨域限制')
      })
    return () => {
      cancelled = true
    }
  }, [open, imageUrl])

  React.useEffect(() => {
    if (!image || !canvasRef.current) return
    drawImageWithMasks(canvasRef.current, image, layers)
  }, [image, layers])

  if (!open) return null

  const activeLayer = layers.find((layer) => layer.id === activeLayerId) ?? layers[0] ?? null
  const ready = !!image && layers.length > 0
  const imageWidth = image?.naturalWidth || image?.width || 1
  const imageHeight = image?.naturalHeight || image?.height || 1

  function updateActiveBox(updater: (box: MaskBox) => MaskBox) {
    if (!activeLayer) return
    setLayers((prev) => prev.map((layer) => (layer.id === activeLayer.id ? { ...layer, box: updater(layer.box) } : layer)))
  }

  function canvasPoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    }
  }

  function hitLayer(x: number, y: number) {
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const box = layers[i].box
      if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return layers[i]
    }
    return null
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!ready || !activeLayer) return
    const p = canvasPoint(e)
    const hit = hitLayer(p.x, p.y)
    const target = hit ?? activeLayer
    const box = target.box
    setActiveLayerId(target.id)
    if (hit) {
      dragRef.current = { layerId: target.id, dx: p.x - box.x, dy: p.y - box.y }
    } else {
      const nextX = Math.max(0, Math.min(imageWidth - box.width, p.x - box.width / 2))
      const nextY = Math.max(0, Math.min(imageHeight - box.height, p.y - box.height / 2))
      setLayers((prev) => prev.map((layer) => (layer.id === target.id ? { ...layer, box: { ...layer.box, x: nextX, y: nextY } } : layer)))
      dragRef.current = { layerId: target.id, dx: box.width / 2, dy: box.height / 2 }
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragRef.current || !ready) return
    const p = canvasPoint(e)
    const drag = dragRef.current
    setLayers((prev) =>
      prev.map((layer) => {
        if (layer.id !== drag.layerId) return layer
        const nextX = Math.max(0, Math.min(imageWidth - layer.box.width, p.x - drag.dx))
        const nextY = Math.max(0, Math.min(imageHeight - layer.box.height, p.y - drag.dy))
        return { ...layer, box: { ...layer.box, x: nextX, y: nextY } }
      }),
    )
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  async function addDefaultLayer() {
    if (!image) return
    const mask = await loadImage(defaultMaskUrl())
    setLayers((prev) => {
      const next = createLayer(mask, image, prev.length + 1, prev.length * 38)
      setActiveLayerId(next.id)
      return [...prev, next]
    })
  }

  async function pickMask(file: File | null) {
    if (!file || !image) return
    try {
      const url = await transparentizeMask(file)
      const mask = await loadImage(url)
      setLayers((prev) => {
        const next = createLayer(mask, image, prev.length + 1, prev.length * 38)
        next.name = `上传遮罩 ${prev.length + 1}`
        setActiveLayerId(next.id)
        return [...prev, next]
      })
      if (maskInputRef.current) maskInputRef.current.value = ''
    } catch {
      setError('遮罩读取失败')
    }
  }

  function duplicateActiveLayer() {
    if (!activeLayer) return
    const copyLayer: MaskLayer = {
      ...activeLayer,
      id: layerId(),
      name: `${activeLayer.name} 副本`,
      box: {
        ...activeLayer.box,
        x: Math.min(imageWidth - activeLayer.box.width, activeLayer.box.x + 38),
        y: Math.min(imageHeight - activeLayer.box.height, activeLayer.box.y + 38),
      },
    }
    setLayers((prev) => [...prev, copyLayer])
    setActiveLayerId(copyLayer.id)
  }

  function removeActiveLayer() {
    if (!activeLayer || layers.length <= 1) return
    setLayers((prev) => {
      const rest = prev.filter((layer) => layer.id !== activeLayer.id)
      setActiveLayerId(rest[rest.length - 1]?.id ?? null)
      return rest
    })
  }

  function save() {
    if (!canvasRef.current || !ready || saving) return
    let dataUrl: string
    try {
      dataUrl = canvasRef.current.toDataURL('image/png', 0.96)
    } catch {
      setError('图片导出失败（跨域限制）')
      return
    }
    setSaving(true)
    setError('')
    void Promise.resolve(onSave(dataUrl))
      .then(() => onClose())
      .catch(() => {
        setSaving(false)
        setError('保存失败，请重试')
      })
  }

  return (
    <div className="facemask-overlay" role="dialog" aria-modal="true">
      <div className="facemask-dialog">
        <div className="facemask-header">
          <div>
            <h2>遮脸编辑：{title}</h2>
            <p>可添加多个遮罩，分别拖到需要遮挡的人脸位置；保存后将替换原图。</p>
          </div>
          <button className="facemask-close" onClick={onClose} aria-label="关闭" type="button">
            <X size={16} />
          </button>
        </div>

        <div className="facemask-body">
          <div className="facemask-canvas-area">
            {ready ? (
              <canvas
                ref={canvasRef}
                className="facemask-canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
            ) : (
              <div className="facemask-loading">{error ? error : <Loader2 className="spin" size={20} />}</div>
            )}
          </div>

          <aside className="facemask-panel">
            <div className="facemask-section">
              <div className="facemask-section-head">
                <span>遮罩层</span>
                <span className="facemask-muted">{layers.length} 层</span>
              </div>
              <div className="facemask-layers">
                {layers.map((layer) => (
                  <button
                    key={layer.id}
                    type="button"
                    onClick={() => setActiveLayerId(layer.id)}
                    className={`facemask-layer ${activeLayerId === layer.id ? 'active' : ''}`}
                  >
                    <span className="facemask-layer-name">
                      <Layers size={13} />
                      {layer.name}
                    </span>
                    <span>{Math.round(layer.box.opacity * 100)}%</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="facemask-section">
              <span className="facemask-label">添加遮罩</span>
              <div className="facemask-grid2">
                <button className="facemask-btn" type="button" onClick={() => maskInputRef.current?.click()}>
                  <Upload size={14} /> 上传
                </button>
                <button className="facemask-btn" type="button" onClick={addDefaultLayer}>
                  <ImagePlus size={14} /> 默认
                </button>
              </div>
              <input ref={maskInputRef} type="file" accept="image/*" hidden onChange={(e) => pickMask(e.target.files?.[0] ?? null)} />
            </div>

            {activeLayer ? (
              <div className="facemask-section">
                <MaskControl
                  label="大小"
                  value={activeLayer.box.width}
                  min={Math.round(imageWidth * 0.04)}
                  max={Math.round(imageWidth * 0.85)}
                  onChange={(width) => {
                    const ratio = activeLayer.box.height / Math.max(1, activeLayer.box.width)
                    updateActiveBox((box) => ({ ...box, width, height: Math.round(width * ratio) }))
                  }}
                />
                <MaskControl
                  label="透明度"
                  value={Math.round(activeLayer.box.opacity * 100)}
                  min={20}
                  max={100}
                  suffix="%"
                  onChange={(value) => updateActiveBox((box) => ({ ...box, opacity: value / 100 }))}
                />
                <MaskControl
                  label="旋转"
                  value={activeLayer.box.rotation}
                  min={-45}
                  max={45}
                  suffix="°"
                  onChange={(rotation) => updateActiveBox((box) => ({ ...box, rotation }))}
                />
                <div className="facemask-grid5">
                  <button className="facemask-btn" type="button" onClick={() => updateActiveBox((box) => ({ ...box, rotation: box.rotation - 8 }))}>
                    <RotateCcw size={14} />
                  </button>
                  <button
                    className="facemask-btn"
                    type="button"
                    onClick={() =>
                      updateActiveBox((box) => ({ ...box, x: Math.round((imageWidth - box.width) / 2), y: Math.round((imageHeight - box.height) / 2) }))
                    }
                  >
                    <Move size={14} />
                  </button>
                  <button className="facemask-btn" type="button" onClick={() => updateActiveBox((box) => ({ ...box, rotation: box.rotation + 8 }))}>
                    <RotateCw size={14} />
                  </button>
                  <button className="facemask-btn" type="button" onClick={duplicateActiveLayer} title="复制当前遮罩">
                    <Copy size={14} />
                  </button>
                  <button className="facemask-btn danger" type="button" onClick={removeActiveLayer} disabled={layers.length <= 1} title="删除当前遮罩">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ) : null}

            {error ? <div className="facemask-error">{error}</div> : null}

            <div className="facemask-actions">
              <button className="facemask-btn" type="button" onClick={onClose} disabled={saving}>
                取消
              </button>
              <button className="facemask-btn primary" type="button" onClick={save} disabled={!ready || saving}>
                {saving ? <Loader2 className="spin" size={14} /> : <Save size={14} />} {saving ? '上传中…' : '保存替换'}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

function MaskControl({
  label,
  value,
  min,
  max,
  suffix = '',
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  suffix?: string
  onChange: (value: number) => void
}) {
  return (
    <div className="facemask-control">
      <div className="facemask-control-head">
        <span>{label}</span>
        <span className="facemask-muted">
          {Math.round(value)}
          {suffix}
        </span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  )
}
