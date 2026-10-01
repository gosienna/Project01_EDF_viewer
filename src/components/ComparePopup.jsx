import React, { useCallback, useEffect, useRef, useState } from 'react'

const PAD = { top: 10, right: 16, bottom: 26, left: 108 }
const MIN_WINDOW_SECONDS = 5
const WHEEL_ZOOM_BASE = 1.15
const Y_WHEEL_ZOOM_BASE = 1.15
const MIN_Y_ZOOM = 0.25
const MAX_Y_ZOOM = 32
const DEFAULT_Y_ZOOM = 1
const SHARED_SCALE_KEY = 'shared'
const MIN_POPUP_WIDTH = 320
const MIN_POPUP_HEIGHT = 220
const POPUP_INSET = 16
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

function clampViewStart(start, windowSeconds, totalDuration) {
  return Math.max(0, Math.min(start, Math.max(0, totalDuration - windowSeconds)))
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

function downsampleRange(data, startIndex, endIndex, targetPoints) {
  const start = Math.max(0, Math.floor(startIndex))
  const end = Math.min(data.length, Math.ceil(endIndex))
  const length = end - start
  if (length <= 0) return []

  const points = Math.min(targetPoints, length)
  const result = new Array(points)

  for (let i = 0; i < points; i += 1) {
    const sliceStart = start + Math.floor((i * length) / points)
    const sliceEnd = start + Math.floor(((i + 1) * length) / points)
    let min = Infinity
    let max = -Infinity

    for (let j = sliceStart; j < sliceEnd; j += 1) {
      const value = data[j]
      if (value < min) min = value
      if (value > max) max = value
    }

    result[i] = { min, max }
  }

  return result
}

function maskSegments(data, startIndex, endIndex, targetPoints) {
  const start = Math.max(0, Math.floor(startIndex))
  const end = Math.min(data.length, Math.ceil(endIndex))
  const length = end - start
  if (length <= 0) return []

  const points = Math.min(targetPoints, length)
  const segments = []
  let inSegment = false
  let segmentStart = 0

  for (let i = 0; i < points; i += 1) {
    const sliceStart = start + Math.floor((i * length) / points)
    const sliceEnd = start + Math.floor(((i + 1) * length) / points)
    let active = false
    for (let j = sliceStart; j < sliceEnd; j += 1) {
      if (data[j] > 0.5) {
        active = true
        break
      }
    }

    const x = i / Math.max(points - 1, 1)
    if (active && !inSegment) {
      inSegment = true
      segmentStart = x
    } else if (!active && inSegment) {
      inSegment = false
      segments.push({ start: segmentStart, end: x })
    }
  }

  if (inSegment) segments.push({ start: segmentStart, end: 1 })
  return segments
}

function resizeFrame(drag, clientX, clientY, parentWidth, parentHeight) {
  const dx = clientX - drag.startX
  const dy = clientY - drag.startY
  const { edge } = drag
  let width = drag.startWidth
  let height = drag.startHeight
  let x = drag.originX
  let y = drag.originY

  if (edge.includes('e')) width = drag.startWidth + dx
  if (edge.includes('s')) height = drag.startHeight + dy
  if (edge.includes('w')) {
    width = drag.startWidth - dx
    x = drag.originX + dx
  }
  if (edge.includes('n')) {
    height = drag.startHeight - dy
    y = drag.originY + dy
  }

  const maxWidth = Number.isFinite(parentWidth) ? parentWidth : width
  const maxHeight = Number.isFinite(parentHeight) ? parentHeight : height

  if (edge.includes('e')) {
    width = Math.min(width, maxWidth - (POPUP_INSET + x))
  }
  if (edge.includes('s')) {
    height = Math.min(height, maxHeight - (POPUP_INSET + y))
  }
  if (edge.includes('w') && POPUP_INSET + x < 0) {
    width += POPUP_INSET + x
    x = -POPUP_INSET
  }
  if (edge.includes('n') && POPUP_INSET + y < 0) {
    height += POPUP_INSET + y
    y = -POPUP_INSET
  }

  if (width < MIN_POPUP_WIDTH) {
    if (edge.includes('w')) x -= MIN_POPUP_WIDTH - width
    width = MIN_POPUP_WIDTH
  }
  if (height < MIN_POPUP_HEIGHT) {
    if (edge.includes('n')) y -= MIN_POPUP_HEIGHT - height
    height = MIN_POPUP_HEIGHT
  }

  return {
    width: Math.max(MIN_POPUP_WIDTH, Math.round(width)),
    height: Math.max(MIN_POPUP_HEIGHT, Math.round(height)),
    x,
    y,
  }
}

function visibleRange(minVal, maxVal, yZoom) {
  const center = (minVal + maxVal) / 2
  const span = (maxVal - minVal || 1) / yZoom
  return {
    displayMin: center - span / 2,
    displayMax: center + span / 2,
    displayRange: span,
  }
}

export default function ComparePopup({
  channels,
  totalDuration,
  initialViewStart,
  initialWindowSeconds,
  shareScale,
  onClose,
}) {
  const canvasRef = useRef(null)
  const popupRef = useRef(null)
  const plotRef = useRef(null)
  const stripsRef = useRef([])
  const viewRef = useRef(null)
  const dragRef = useRef(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [frameSize, setFrameSize] = useState(null)
  const [canvasSize, setCanvasSize] = useState({ width: 640, height: 360 })
  const [windowSeconds, setWindowSeconds] = useState(() =>
    Math.max(MIN_WINDOW_SECONDS, Math.min(totalDuration || MIN_WINDOW_SECONDS, initialWindowSeconds || 60))
  )
  const [viewStart, setViewStart] = useState(() =>
    clampViewStart(initialViewStart || 0, initialWindowSeconds || 60, totalDuration || 0)
  )
  const [yZoom, setYZoom] = useState({})
  const [yRange, setYRange] = useState({})

  const viewEnd = Math.min(viewStart + windowSeconds, totalDuration || 0)

  viewRef.current = {
    viewStart,
    windowSeconds,
    yZoom,
    yRange,
    channels,
    shareScale,
    totalDuration,
  }

  useEffect(() => {
    const plot = plotRef.current
    if (!plot) return undefined

    const updateSize = () => {
      const width = plot.clientWidth
      const height = plot.clientHeight
      if (width > 0 && height > 0) setCanvasSize({ width, height })
    }

    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(plot)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const width = canvasSize.width
    const height = canvasSize.height
    const plotWidth = Math.max(1, width - PAD.left - PAD.right)
    const plotHeight = Math.max(1, height - PAD.top - PAD.bottom)

    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)

    if (!channels.length) {
      ctx.fillStyle = '#718096'
      ctx.font = '14px Inter, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('Select channels to compare', width / 2, height / 2)
      stripsRef.current = []
      return
    }

    const groups = shareScale
      ? [{ key: SHARED_SCALE_KEY, channels }]
      : channels.map((channel) => ({ key: channel.id, channels: [channel] }))
    const stripHeight = plotHeight / groups.length
    const strips = []

    groups.forEach((group, index) => {
      const yTop = PAD.top + index * stripHeight
      const yBottom = yTop + stripHeight
      const sequenceMembers = group.channels.filter((channel) => !channel.isMask)
      const axisMembers = sequenceMembers.length > 0 ? sequenceMembers : group.channels
      let minVal = Infinity
      let maxVal = -Infinity
      const series = axisMembers.map((channel) => {
        const samples = channel.isMask
          ? []
          : downsampleRange(
            channel.data,
            viewStart * channel.sampleRate,
            viewEnd * channel.sampleRate,
            plotWidth
          )
        samples.forEach(({ min, max }) => {
          if (min < minVal) minVal = min
          if (max > maxVal) maxVal = max
        })
        return { channel, samples }
      })

      const custom = yRange[group.key]
      const hasCustom = custom
        && Number.isFinite(custom.min)
        && Number.isFinite(custom.max)
        && custom.min < custom.max
      const zoom = yZoom[group.key] ?? DEFAULT_Y_ZOOM
      let displayMin = 0
      let displayMax = 1
      let displayRange = 1
      if (hasCustom) {
        displayMin = custom.min
        displayMax = custom.max
        displayRange = custom.max - custom.min
      } else if (Number.isFinite(minVal) && Number.isFinite(maxVal)) {
        const range = visibleRange(minVal, maxVal, zoom)
        displayMin = range.displayMin
        displayMax = range.displayMax
        displayRange = range.displayRange
      }

      strips.push({
        key: group.key,
        top: yTop,
        bottom: yBottom,
        height: stripHeight,
        displayMin,
        displayMax,
        displayRange,
      })

      ctx.strokeStyle = '#edf2f7'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(PAD.left, (yTop + yBottom) / 2)
      ctx.lineTo(width - PAD.right, (yTop + yBottom) / 2)
      ctx.stroke()

      ctx.save()
      ctx.beginPath()
      ctx.rect(PAD.left, yTop, plotWidth, stripHeight)
      ctx.clip()

      group.channels.forEach((channel) => {
        if (!channel.isMask) return
        const segments = maskSegments(
          channel.data,
          viewStart * channel.sampleRate,
          viewEnd * channel.sampleRate,
          plotWidth
        )
        segments.forEach(({ start, end }) => {
          ctx.fillStyle = `${channel.color}55`
          ctx.fillRect(
            PAD.left + start * plotWidth,
            yTop + 2,
            (end - start) * plotWidth,
            stripHeight - 4
          )
        })
      })

      series.forEach(({ channel, samples }) => {
        if (samples.length === 0) return
        ctx.strokeStyle = channel.color
        ctx.globalAlpha = shareScale ? 0.9 : 1
        ctx.lineWidth = 1.5
        ctx.beginPath()
        samples.forEach((point, pointIndex) => {
          const x = PAD.left + (pointIndex / Math.max(samples.length - 1, 1)) * plotWidth
          const yMin = yBottom - 8 - ((point.min - displayMin) / displayRange) * (stripHeight - 16)
          const yMax = yBottom - 8 - ((point.max - displayMin) / displayRange) * (stripHeight - 16)
          if (pointIndex === 0) ctx.moveTo(x, yMin)
          else ctx.lineTo(x, yMin)
          if (Math.abs(yMax - yMin) > 0.5) ctx.lineTo(x, yMax)
        })
        ctx.stroke()
        ctx.globalAlpha = 1
      })

      ctx.restore()

      ctx.fillStyle = '#4a5568'
      ctx.font = '12px Inter, sans-serif'
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      const label = group.channels.map((channel) => channel.label).join(' · ')
      ctx.save()
      ctx.beginPath()
      ctx.rect(4, yTop, PAD.left - 10, stripHeight)
      ctx.clip()
      ctx.fillText(label, PAD.left - 8, yTop + 14)
      ctx.restore()

      const zoomLabel = !hasCustom && zoom !== DEFAULT_Y_ZOOM ? ` · ${zoom.toFixed(1)}x` : ''
      const fixedLabel = hasCustom ? ' · fixed' : ''
      ctx.fillStyle = '#a0aec0'
      ctx.font = '10px Inter, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(
        `${displayMin.toFixed(1)} – ${displayMax.toFixed(1)}${zoomLabel}${fixedLabel}`,
        PAD.left + 4,
        yTop + 4
      )
    })

    ctx.fillStyle = '#718096'
    ctx.font = '12px Inter, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(
      `${viewStart.toFixed(0)}s – ${viewEnd.toFixed(0)}s  (${formatDuration(totalDuration)} total)`,
      width / 2,
      height - 6
    )

    stripsRef.current = strips
  }, [canvasSize, channels, shareScale, totalDuration, viewEnd, viewStart, yRange, yZoom])

  useEffect(() => {
    const plot = plotRef.current
    if (!plot) return undefined

    const handleWheel = (event) => {
      event.preventDefault()
      event.stopPropagation()

      const canvas = canvasRef.current
      const view = viewRef.current
      if (!canvas || !view) return

      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const scaleX = canvas.width / rect.width
      const scaleY = canvas.height / rect.height
      const mouseX = (event.clientX - rect.left) * scaleX
      const mouseY = (event.clientY - rect.top) * scaleY
      const plotWidth = canvas.width - PAD.left - PAD.right
      if (plotWidth <= 0) return

      const strip = stripsRef.current.find((item) => mouseY >= item.top && mouseY < item.bottom)
      if (mouseX < PAD.left && strip) {
        const zoomFactor = Y_WHEEL_ZOOM_BASE ** (-event.deltaY / 100)
        const currentRange = view.yRange[strip.key]
        if (currentRange) {
          const center = (currentRange.min + currentRange.max) / 2
          const nextHalf = ((currentRange.max - currentRange.min) / 2) / zoomFactor
          setYRange((prev) => ({
            ...prev,
            [strip.key]: { min: center - nextHalf, max: center + nextHalf },
          }))
          return
        }

        setYZoom((prev) => {
          const current = prev[strip.key] ?? DEFAULT_Y_ZOOM
          const next = Math.max(MIN_Y_ZOOM, Math.min(MAX_Y_ZOOM, current * zoomFactor))
          if (next === current) return prev
          return { ...prev, [strip.key]: next }
        })
        return
      }

      const fraction = Math.max(0, Math.min(1, (mouseX - PAD.left) / plotWidth))
      const timeAtMouse = view.viewStart + fraction * view.windowSeconds
      const zoomFactor = WHEEL_ZOOM_BASE ** (-event.deltaY / 100)
      const nextWindow = Math.max(
        MIN_WINDOW_SECONDS,
        Math.min(view.totalDuration || MIN_WINDOW_SECONDS, view.windowSeconds * zoomFactor)
      )
      if (nextWindow === view.windowSeconds) return
      setWindowSeconds(nextWindow)
      setViewStart(clampViewStart(
        timeAtMouse - fraction * nextWindow,
        nextWindow,
        view.totalDuration
      ))
    }

    plot.addEventListener('wheel', handleWheel, { passive: false })
    return () => plot.removeEventListener('wheel', handleWheel)
  }, [])

  const panBy = useCallback((fraction) => {
    setViewStart((prev) => clampViewStart(prev + windowSeconds * fraction, windowSeconds, totalDuration))
  }, [totalDuration, windowSeconds])

  const zoomTime = useCallback((factor) => {
    const nextWindow = Math.max(
      MIN_WINDOW_SECONDS,
      Math.min(totalDuration || MIN_WINDOW_SECONDS, windowSeconds * factor)
    )
    const center = viewStart + windowSeconds / 2
    setWindowSeconds(nextWindow)
    setViewStart(clampViewStart(center - nextWindow / 2, nextWindow, totalDuration))
  }, [totalDuration, viewStart, windowSeconds])

  const beginWindowDrag = (event) => {
    if (event.button !== 0) return
    dragRef.current = {
      kind: 'window',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const moveWindow = (event) => {
    const drag = dragRef.current
    if (!drag || drag.kind !== 'window' || event.pointerId !== drag.pointerId) return
    setOffset({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    })
  }

  const endWindowDrag = (event) => {
    const drag = dragRef.current
    if (!drag || drag.kind !== 'window' || event.pointerId !== drag.pointerId) return
    dragRef.current = null
  }

  const beginResize = (event, edge) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const popup = popupRef.current
    if (!popup) return
    const rect = popup.getBoundingClientRect()
    dragRef.current = {
      kind: 'resize',
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      originX: offset.x,
      originY: offset.y,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const moveResize = (event) => {
    const drag = dragRef.current
    if (!drag || drag.kind !== 'resize' || event.pointerId !== drag.pointerId) return
    const parent = popupRef.current?.offsetParent
    const next = resizeFrame(
      drag,
      event.clientX,
      event.clientY,
      parent?.clientWidth ?? Infinity,
      parent?.clientHeight ?? Infinity
    )
    setFrameSize({ width: next.width, height: next.height })
    setOffset({ x: next.x, y: next.y })
  }

  const endResize = (event) => {
    const drag = dragRef.current
    if (!drag || drag.kind !== 'resize' || event.pointerId !== drag.pointerId) return
    dragRef.current = null
  }

  const beginPlotDrag = (event) => {
    if (event.button !== 0) return
    const canvas = canvasRef.current
    const view = viewRef.current
    if (!canvas || !view) return

    const rect = canvas.getBoundingClientRect()
    const scaleY = canvas.height / rect.height
    const mouseY = (event.clientY - rect.top) * scaleY
    const strip = stripsRef.current.find((item) => mouseY >= item.top && mouseY < item.bottom)
    dragRef.current = {
      kind: 'plot',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startView: view.viewStart,
      windowSeconds: view.windowSeconds,
      mode: null,
      stripKey: strip?.key ?? null,
      startMin: strip?.displayMin ?? 0,
      startMax: strip?.displayMax ?? 1,
      displayRange: strip?.displayRange ?? 1,
      stripHeight: strip?.height ?? 1,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const movePlot = (event) => {
    const drag = dragRef.current
    if (!drag || drag.kind !== 'plot' || event.pointerId !== drag.pointerId) return

    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.mode) {
      if (Math.hypot(dx, dy) < 4) return
      drag.mode = Math.abs(dx) >= Math.abs(dy) ? 'time' : 'scale'
    }

    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()

    if (drag.mode === 'time') {
      const plotWidth = Math.max(1, rect.width * ((canvas.width - PAD.left - PAD.right) / canvas.width))
      const deltaTime = -(dx / plotWidth) * drag.windowSeconds
      setViewStart(clampViewStart(drag.startView + deltaTime, drag.windowSeconds, totalDuration))
      return
    }

    if (!drag.stripKey || drag.stripHeight <= 0) return
    const scaleY = canvas.height / rect.height
    const deltaValue = -((dy * scaleY) * drag.displayRange) / drag.stripHeight
    setYRange((prev) => ({
      ...prev,
      [drag.stripKey]: {
        min: drag.startMin + deltaValue,
        max: drag.startMax + deltaValue,
      },
    }))
    setYZoom((prev) => {
      if (!prev[drag.stripKey]) return prev
      const next = { ...prev }
      delete next[drag.stripKey]
      return next
    })
  }

  const endPlotDrag = (event) => {
    const drag = dragRef.current
    if (!drag || drag.kind !== 'plot' || event.pointerId !== drag.pointerId) return
    dragRef.current = null
  }

  const names = channels.map((channel) => channel.label).join(', ')

  return (
    <section
      ref={popupRef}
      className="compare-popup"
      style={{
        transform: `translate(${offset.x}px, ${offset.y}px)`,
        width: frameSize ? `${frameSize.width}px` : undefined,
        height: frameSize ? `${frameSize.height}px` : undefined,
      }}
      role="dialog"
      aria-label="Compare channels"
    >
      <header
        className="compare-popup-header"
        onPointerDown={beginWindowDrag}
        onPointerMove={moveWindow}
        onPointerUp={endWindowDrag}
        onPointerCancel={endWindowDrag}
      >
        <div className="compare-popup-heading">
          <h3>Compare</h3>
          <p title={names}>{names || 'No channels selected'}</p>
        </div>
        <button
          className="btn btn-secondary btn-small"
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
        >
          Close
        </button>
      </header>
      <div
        className="compare-popup-plot"
        ref={plotRef}
        onPointerDown={beginPlotDrag}
        onPointerMove={movePlot}
        onPointerUp={endPlotDrag}
        onPointerCancel={endPlotDrag}
        title="Scroll the plot to zoom time. Scroll a channel name to zoom its scale. Drag sideways to pan, or up and down to shift the scale."
      >
        <canvas
          ref={canvasRef}
          className="compare-popup-canvas"
          width={canvasSize.width}
          height={canvasSize.height}
        />
      </div>
      <footer className="compare-popup-footer">
        <button className="btn btn-small" type="button" onClick={() => zoomTime(1 / WHEEL_ZOOM_BASE)}>🔍+</button>
        <button className="btn btn-small" type="button" onClick={() => zoomTime(WHEEL_ZOOM_BASE)}>🔍-</button>
        <button className="btn btn-small" type="button" onClick={() => panBy(-0.5)}>←</button>
        <button className="btn btn-small" type="button" onClick={() => panBy(0.5)}>→</button>
        <span className="time-info">
          {viewStart.toFixed(0)}s – {viewEnd.toFixed(0)}s ({Math.round(windowSeconds)}s)
        </span>
      </footer>
      {RESIZE_EDGES.map((edge) => (
        <div
          key={edge}
          className={`compare-popup-resize compare-popup-resize-${edge}`}
          onPointerDown={(event) => beginResize(event, edge)}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          role="separator"
          aria-orientation={edge === 'n' || edge === 's' ? 'horizontal' : 'vertical'}
          aria-label="Resize compare window"
        />
      ))}
    </section>
  )
}
