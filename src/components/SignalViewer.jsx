import React, { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'react'
import {
  ANNOTATION_CHANNEL_ID_BASE,
  buildAnnotationChannels,
  buildDefaultAnnotationGroups,
  collectVisibleAnnotationMarks,
  getUniqueAnnotationLabels,
  nearestAnnotationEvent,
  normalizeAnnotationGroups,
  paintAnnotationMarks,
  serializeAnnotationGroups,
} from '../utils/annotationChannels'
import { deleteViewPreset, listViewPresets, saveViewPreset, updateViewPresetById } from '../utils/viewPresets'
import { deleteBinaryMaskEdit, getBinaryMaskEdits, saveBinaryMaskEdit } from '../utils/binaryMaskStorage'
import { buildEdfSummary, deleteEdfRecord, findEdfRecordsByFileName, saveEdfRecord, updateEdfRecord } from '../utils/edfStorage'
import { buildEdfBuffer } from '../utils/edfWriter'
import {
  PARQUET_CHANNEL_ID_BASE,
  buildImportedChannel,
  defaultImportSampleRateText,
  importChannelLabel,
  parseSampleRateText,
  readParquetNumericColumns,
  uniqueChannelLabel,
} from '../utils/parquetImport'
import ChannelYRangeDialog from './ChannelYRangeDialog'
import ComparePopup from './ComparePopup'
import ExportDataDialog from './ExportDataDialog'
import SaveEdfConflictDialog from './SaveEdfConflictDialog'

const CHANNEL_COLORS = [
  '#667eea', '#e53e3e', '#38a169', '#d69e2e', '#805ad5',
  '#319795', '#dd6b20', '#d53f8c', '#2b6cb0', '#718096',
]

const BINARY_MASK_COLORS = [
  { fill: 'rgba(229, 62, 62, 0.25)', stroke: 'rgba(229, 62, 62, 0.65)', strong: 'rgba(229, 62, 62, 0.42)' },
  { fill: 'rgba(56, 161, 105, 0.25)', stroke: 'rgba(56, 161, 105, 0.65)', strong: 'rgba(56, 161, 105, 0.42)' },
  { fill: 'rgba(214, 158, 46, 0.25)', stroke: 'rgba(214, 158, 46, 0.65)', strong: 'rgba(214, 158, 46, 0.42)' },
  { fill: 'rgba(128, 90, 213, 0.25)', stroke: 'rgba(128, 90, 213, 0.65)', strong: 'rgba(128, 90, 213, 0.42)' },
  { fill: 'rgba(49, 151, 149, 0.25)', stroke: 'rgba(49, 151, 149, 0.65)', strong: 'rgba(49, 151, 149, 0.42)' },
  { fill: 'rgba(221, 107, 32, 0.25)', stroke: 'rgba(221, 107, 32, 0.65)', strong: 'rgba(221, 107, 32, 0.42)' },
  { fill: 'rgba(213, 63, 140, 0.25)', stroke: 'rgba(213, 63, 140, 0.65)', strong: 'rgba(213, 63, 140, 0.42)' },
  { fill: 'rgba(43, 108, 176, 0.25)', stroke: 'rgba(43, 108, 176, 0.65)', strong: 'rgba(43, 108, 176, 0.42)' },
]
const BINARY_EPS = 1e-6

const DEPICTION_FORMATS = {
  SEQUENCE: 'sequence',
  BINARY_MASK: 'binary_mask',
  STEM: 'stem',
}

const COMPOSE_MODES = {
  BACKDROP: 'backdrop',
  OVERLAY: 'overlay',
}

const OVERLAY_RANGE_PREFIX = 'overlay:'
const LEGACY_OVERLAY_RANGE_KEY = 'overlay'
const OVERLAY_LINE_ALPHA = 0.55

function getOverlayRangeKey(memberIds) {
  return `${OVERLAY_RANGE_PREFIX}${[...memberIds].sort((a, b) => a - b).join(',')}`
}

function isOverlayRangeKey(key) {
  return typeof key === 'string'
    && (key === LEGACY_OVERLAY_RANGE_KEY || key.startsWith(OVERLAY_RANGE_PREFIX))
}

function sanitizeOverlayGroups(groups) {
  const seen = new Set()
  const next = []
  ;(groups ?? []).forEach((group) => {
    const members = []
    ;(group ?? []).forEach((id) => {
      const channelId = Number(id)
      if (!Number.isFinite(channelId) || seen.has(channelId)) return
      seen.add(channelId)
      members.push(channelId)
    })
    if (members.length >= 2) next.push(members)
  })
  return next
}

function findMatchingOverlayGroupIndex(groups, selectedIds) {
  if (!selectedIds || selectedIds.length < 2) return -1
  const selectedSet = new Set(selectedIds.map(Number))
  return (groups ?? []).findIndex((group) => (
    group.length === selectedSet.size && group.every((id) => selectedSet.has(id))
  ))
}

function overlayGroupsEqual(a, b) {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((group, index) => {
    const other = b[index]
    return other
      && group.length === other.length
      && group.every((id, memberIndex) => id === other[memberIndex])
  })
}
const SELECTION_HIGHLIGHT = 'rgba(102, 126, 234, 0.16)'

const DEPICTION_OPTIONS = [
  { value: DEPICTION_FORMATS.SEQUENCE, label: 'Sequence' },
  { value: DEPICTION_FORMATS.BINARY_MASK, label: 'Binary mask' },
]

const ANNOTATION_DEPICTION_OPTIONS = [
  { value: DEPICTION_FORMATS.STEM, label: 'Stem' },
]

const DEFAULT_CHANNELS = ['spo2', 'ihr', 'resp_norm', 'temperature', 'actigraphy']

const VIEWER_TABS = {
  VIEWER: 'viewer',
  CURRENT_VIEW: 'current-view',
  CHANNELS: 'channels',
  IMPORT: 'import',
}

const VIEWER_TAB_ITEMS = [
  { id: VIEWER_TABS.VIEWER, label: 'Signal Viewer' },
  { id: VIEWER_TABS.CURRENT_VIEW, label: 'View Format' },
  { id: VIEWER_TABS.CHANNELS, label: 'Channel Select' },
  { id: VIEWER_TABS.IMPORT, label: 'Import Data' },
]

const PLOT_PADDING = { top: 20, right: 20, bottom: 30, left: 70 }
const DEFAULT_CHANNEL_LABEL_WIDTH = PLOT_PADDING.left
const MIN_CHANNEL_LABEL_WIDTH = 48
const MAX_CHANNEL_LABEL_WIDTH = 280
const MIN_WINDOW_SECONDS = 5
const WHEEL_ZOOM_BASE = 1.15
const DEFAULT_CHANNEL_STRIP_HEIGHT = 80
const MIN_CHANNEL_STRIP_HEIGHT = 40
const MIN_PANEL_HEIGHT = 200
const DEFAULT_PANEL_HEIGHT = 600
const PANEL_RESIZE_HANDLE_HEIGHT = 10
const Y_VALUE_REGION_WIDTH = 88
const Y_WHEEL_ZOOM_BASE = 1.15
const MIN_Y_ZOOM = 0.25
const MAX_Y_ZOOM = 32
const DEFAULT_Y_ZOOM = 1
const OVERVIEW_STRIP_HEIGHT = 56
const CHANNEL_REORDER_DRAG_THRESHOLD = 4

function getDetailChannelsTop() {
  return PLOT_PADDING.top + OVERVIEW_STRIP_HEIGHT
}

function getDefaultOverviewChannelId(channels, preferredIds = []) {
  const preferred = preferredIds.find((id) => channels.some((ch) => ch.id === id))
  if (preferred !== undefined) return preferred

  const defaultSelection = getDefaultSelection(channels)
  if (defaultSelection.length > 0) return defaultSelection[0]

  return channels[0]?.id ?? null
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

function getPhysiologicalChannels(channels) {
  return channels.filter((ch) => !ch.isAnnotationChannel)
}

function getDefaultSelection(channels) {
  const physiological = getPhysiologicalChannels(channels)
  const preferred = physiological
    .filter((ch) => DEFAULT_CHANNELS.includes(ch.label.toLowerCase()))
    .map((ch) => ch.id)

  if (preferred.length > 0) return preferred

  return physiological.slice(0, 5).map((ch) => ch.id)
}

function isAnnotationChannelId(channelId) {
  const id = Number(channelId)
  return id >= ANNOTATION_CHANNEL_ID_BASE && id < PARQUET_CHANNEL_ID_BASE
}

function resolveAnnotationBundle(edfData, annotationGroups, totalDuration) {
  const uniqueLabels = getUniqueAnnotationLabels(edfData.annotations ?? [])
  const groups = normalizeAnnotationGroups(annotationGroups, uniqueLabels)
  const annotationChannels = buildAnnotationChannels(
    edfData.annotations ?? [],
    totalDuration ?? edfData.totalDuration ?? 0,
    groups
  )
  return {
    uniqueLabels,
    groups,
    annotationChannels,
    allChannels: [...edfData.channels, ...annotationChannels],
  }
}

function remapSelectedChannelIds(previousIds, previousChannels, nextChannels) {
  const previousById = Object.fromEntries((previousChannels ?? []).map((ch) => [ch.id, ch]))
  const nextByLabel = Object.fromEntries((nextChannels ?? []).map((ch) => [ch.label, ch.id]))
  const remapped = []
  const seen = new Set()

  for (const id of previousIds ?? []) {
    const previous = previousById[id]
    if (!previous) continue
    const nextId = nextByLabel[previous.label]
    if (nextId === undefined || seen.has(nextId)) continue
    seen.add(nextId)
    remapped.push(nextId)
  }

  return remapped
}

function isBinaryValue(value) {
  return Math.abs(value) <= BINARY_EPS || Math.abs(value - 1) <= BINARY_EPS
}

function isBinarySignal(data) {
  if (data.length === 0) return false
  for (let i = 0; i < data.length; i += 1) {
    if (!isBinaryValue(data[i])) return false
  }
  return true
}

function isActiveBinary(value) {
  return value > 0.5
}

function clientXToTime(clientX, canvas, viewStart, viewEnd, plotLeft = PLOT_PADDING.left) {
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0) return viewStart

  const scaleX = canvas.width / rect.width
  const mouseX = (clientX - rect.left) * scaleX
  const plotWidth = canvas.width - plotLeft - PLOT_PADDING.right
  if (plotWidth <= 0) return viewStart

  const fraction = Math.max(0, Math.min(1, (mouseX - plotLeft) / plotWidth))
  return viewStart + fraction * (viewEnd - viewStart)
}

function timeToSampleIndex(time, sampleRate, dataLength) {
  const index = Math.round(time * sampleRate)
  return Math.max(0, Math.min(dataLength - 1, index))
}

function findActiveEventBounds(data, sampleIndex) {
  if (sampleIndex < 0 || sampleIndex >= data.length) return null
  if (!isActiveBinary(data[sampleIndex])) return null

  let start = sampleIndex
  let end = sampleIndex

  while (start > 0 && isActiveBinary(data[start - 1])) start -= 1
  while (end < data.length - 1 && isActiveBinary(data[end + 1])) end += 1

  return { start, end }
}

function clearEventAt(data, sampleIndex) {
  const bounds = findActiveEventBounds(data, sampleIndex)
  if (!bounds) return null

  const next = data.slice()
  for (let i = bounds.start; i <= bounds.end; i += 1) {
    next[i] = 0
  }
  return next
}

function fillEventRange(data, startSample, endSample) {
  const start = Math.max(0, Math.min(startSample, endSample))
  const end = Math.min(data.length - 1, Math.max(startSample, endSample))
  const next = data.slice()
  for (let i = start; i <= end; i += 1) {
    next[i] = 1
  }
  return next
}

function maskBufferToArray(maskBuffer, expectedLength) {
  const values = Array.from(new Float32Array(maskBuffer))
  if (expectedLength > 0 && values.length !== expectedLength) {
    return values.slice(0, expectedLength)
  }
  return values
}

const MAX_MASK_UNDO_HISTORY = 50

function cloneMaskOverrides(overrides) {
  return Object.fromEntries(
    Object.entries(overrides ?? {}).map(([id, data]) => [id, data.slice()])
  )
}

function getBinaryMaskSegments(data, startIndex, endIndex, targetPoints) {
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
      if (isActiveBinary(data[j])) {
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

  if (inSegment) {
    segments.push({ start: segmentStart, end: 1 })
  }

  return segments
}

function drawBinaryMaskSegments(ctx, segments, xLeft, plotWidth, yTop, yBottom, fillStyle, strokeStyle) {
  segments.forEach(({ start, end }) => {
    const x1 = xLeft + start * plotWidth
    const width = (end - start) * plotWidth
    ctx.fillStyle = fillStyle
    ctx.fillRect(x1, yTop, width, yBottom - yTop)
    if (strokeStyle) {
      ctx.strokeStyle = strokeStyle
      ctx.lineWidth = 1
      ctx.strokeRect(x1, yTop, width, yBottom - yTop)
    }
  })
}

function getBinaryMaskColor(index) {
  return BINARY_MASK_COLORS[index % BINARY_MASK_COLORS.length]
}

function getDefaultBinaryMaskOverlayTargets(channelId, selectedChannels, channelFormats) {
  return selectedChannels.filter(
    (id) =>
      id !== channelId &&
      (channelFormats[id] ?? DEPICTION_FORMATS.SEQUENCE) === DEPICTION_FORMATS.SEQUENCE
  )
}

function defaultDepictionFormat(channel) {
  return channel?.isAnnotationChannel ? DEPICTION_FORMATS.STEM : DEPICTION_FORMATS.SEQUENCE
}

function annotationMarksFor(channel, viewStart, viewEnd, plotWidth) {
  return collectVisibleAnnotationMarks(
    channel?.events,
    viewStart,
    viewEnd,
    plotWidth,
    channel?.maxEventDuration ?? 0
  )
}

function mapOverlayIdsToLabels(overlayRecord, channelById) {
  const byLabel = {}
  Object.entries(overlayRecord ?? {}).forEach(([maskId, targetIds]) => {
    const maskLabel = channelById[maskId]?.label ?? channelById[Number(maskId)]?.label
    if (!maskLabel) return

    byLabel[maskLabel] = targetIds
      .map((targetId) => channelById[targetId]?.label ?? channelById[Number(targetId)]?.label)
      .filter(Boolean)
      .sort()
  })
  return byLabel
}

function normalizeOverlayLabelRecord(record) {
  return Object.fromEntries(
    Object.entries(record ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, targets]) => [label, [...targets].sort()])
  )
}

function clampViewStart(start, windowSeconds, totalDuration) {
  return Math.max(0, Math.min(start, totalDuration - windowSeconds))
}

function getChannelStripHeight(channelStripHeights, channelId) {
  return channelStripHeights[channelId] ?? DEFAULT_CHANNEL_STRIP_HEIGHT
}

function reorderArray(array, fromIndex, toIndex) {
  if (fromIndex === toIndex) return array
  const next = [...array]
  const [item] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, item)
  return next
}

function moveChannelBlock(array, memberIds, insertAt) {
  const memberSet = new Set(memberIds)
  const members = array.filter((id) => memberSet.has(id))
  if (members.length === 0) return array
  const rest = array.filter((id) => !memberSet.has(id))
  const index = Math.max(0, Math.min(insertAt, rest.length))
  return [...rest.slice(0, index), ...members, ...rest.slice(index)]
}

function attachDocumentDragListeners(onMove, onEnd) {
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onEnd)
  document.addEventListener('pointercancel', onEnd)
}

function detachDocumentDragListeners(onMove, onEnd) {
  document.removeEventListener('pointermove', onMove)
  document.removeEventListener('pointerup', onEnd)
  document.removeEventListener('pointercancel', onEnd)
}

function isPrimaryPointerButton(event) {
  return event.button === 0
}

function getChannelIndexAtCanvasY(clientY, canvas, channels, channelStripHeights) {
  const rect = canvas.getBoundingClientRect()
  if (rect.height <= 0 || channels.length === 0) return 0

  const scaleY = canvas.height / rect.height
  const canvasY = (clientY - rect.top) * scaleY
  let offset = getDetailChannelsTop()

  for (let i = 0; i < channels.length; i += 1) {
    const height = getChannelStripHeight(channelStripHeights, channels[i].id)
    if (canvasY < offset + height / 2) return i
    offset += height
  }

  return channels.length - 1
}

function drawOverviewStrip(ctx, {
  channel,
  format,
  padding,
  plotWidth,
  width,
  yTop,
  stripHeight,
  totalDuration,
  viewStart,
  viewEnd,
}) {
  const yBottom = yTop + stripHeight
  const plotTop = yTop + 4
  const plotBottom = yBottom - 4
  const innerHeight = plotBottom - plotTop

  ctx.strokeStyle = '#cbd5e0'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(padding.left, yBottom)
  ctx.lineTo(width - padding.right, yBottom)
  ctx.stroke()

  clipToChannelStrip(ctx, padding.left, plotWidth, yTop, stripHeight)

  if (format === DEPICTION_FORMATS.STEM || channel.isAnnotationChannel) {
    const peak = channel.physicalMax > 0 ? channel.physicalMax : 1
    const marks = annotationMarksFor(channel, 0, Math.max(totalDuration, 0), plotWidth)
    paintAnnotationMarks(ctx, marks, {
      mode: 'stem',
      xLeft: padding.left,
      plotWidth,
      yTop,
      yBottom,
      yForValue: (value) => overviewTraceY(value, yTop, stripHeight, 0, peak),
      strokeStyle: '#718096',
      fillStyle: 'rgba(113, 128, 150, 0.28)',
    })
    ctx.restore()
    return
  }

  if (format === DEPICTION_FORMATS.BINARY_MASK) {
    const segments = getBinaryMaskSegments(channel.data, 0, channel.data.length, plotWidth)
    drawBinaryMaskSegments(
      ctx,
      segments,
      padding.left,
      plotWidth,
      plotTop,
      plotBottom,
      'rgba(229, 62, 62, 0.35)',
      'rgba(229, 62, 62, 0.6)'
    )
  } else {
    const samples = downsampleRange(channel.data, 0, channel.data.length, plotWidth)
    if (samples.length > 0) {
      let minVal = Infinity
      let maxVal = -Infinity
      samples.forEach(({ min, max }) => {
        if (min < minVal) minVal = min
        if (max > maxVal) maxVal = max
      })
      const range = maxVal - minVal || 1

      ctx.strokeStyle = '#718096'
      ctx.lineWidth = 1
      ctx.beginPath()
      samples.forEach((point, index) => {
        const x = padding.left + (index / Math.max(samples.length - 1, 1)) * plotWidth
        const yMin = plotBottom - ((point.min - minVal) / range) * innerHeight
        const yMax = plotBottom - ((point.max - minVal) / range) * innerHeight

        if (index === 0) {
          ctx.moveTo(x, yMin)
        } else {
          ctx.lineTo(x, yMin)
        }
        if (Math.abs(yMax - yMin) > 0.5) {
          ctx.lineTo(x, yMax)
        }
      })
      ctx.stroke()
    }
  }

  const x1 = padding.left + (viewStart / totalDuration) * plotWidth
  const x2 = padding.left + (viewEnd / totalDuration) * plotWidth
  const highlightWidth = Math.max(x2 - x1, 2)

  ctx.fillStyle = 'rgba(102, 126, 234, 0.18)'
  ctx.fillRect(x1, plotTop, highlightWidth, innerHeight)
  ctx.strokeStyle = '#667eea'
  ctx.lineWidth = 2
  ctx.strokeRect(x1, plotTop, highlightWidth, innerHeight)

  ctx.restore()
}

function getCanvasHeightForPanel(panelHeight) {
  return Math.max(
    MIN_PANEL_HEIGHT - PANEL_RESIZE_HANDLE_HEIGHT,
    panelHeight - PANEL_RESIZE_HANDLE_HEIGHT
  )
}

function getPlotHeightForPanel(panelHeight) {
  return Math.max(
    0,
    getCanvasHeightForPanel(panelHeight)
      - PLOT_PADDING.top
      - PLOT_PADDING.bottom
      - OVERVIEW_STRIP_HEIGHT
  )
}

function getWindowFillingPanelHeight(container) {
  if (!container) return DEFAULT_PANEL_HEIGHT

  const rect = container.getBoundingClientRect()
  const timeControls = container.parentElement?.querySelector('.time-controls')
  const timeHeight = timeControls?.getBoundingClientRect().height ?? 0
  const marginBottom = parseFloat(getComputedStyle(container).marginBottom) || 0
  const section = container.closest('.viewer-section')
  const sectionPaddingBottom = section
    ? parseFloat(getComputedStyle(section).paddingBottom) || 0
    : 0
  const available = window.innerHeight - rect.top - marginBottom - timeHeight - sectionPaddingBottom

  return Math.max(MIN_PANEL_HEIGHT, Math.floor(available))
}

function distributeChannelStripHeights(activeChannels, channelStripHeights, targetPlotHeight) {
  if (activeChannels.length === 0) return channelStripHeights

  const weights = activeChannels.map((channel) =>
    Math.max(MIN_CHANNEL_STRIP_HEIGHT, getChannelStripHeight(channelStripHeights, channel.id))
  )
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
  const minTotal = activeChannels.length * MIN_CHANNEL_STRIP_HEIGHT
  const plotHeight = Math.max(targetPlotHeight, minTotal)

  const next = { ...channelStripHeights }
  let assigned = 0

  activeChannels.forEach((channel, index) => {
    if (index === activeChannels.length - 1) {
      next[channel.id] = Math.max(MIN_CHANNEL_STRIP_HEIGHT, plotHeight - assigned)
      return
    }

    const height = Math.max(
      MIN_CHANNEL_STRIP_HEIGHT,
      (weights[index] / weightSum) * plotHeight
    )
    next[channel.id] = height
    assigned += height
  })

  return next
}

function getVisibleValueRange(minVal, maxVal, yZoom) {
  const dataCenter = (minVal + maxVal) / 2
  const dataRange = maxVal - minVal || 1
  const visibleRange = dataRange / yZoom
  return {
    displayMin: dataCenter - visibleRange / 2,
    displayMax: dataCenter + visibleRange / 2,
    displayRange: visibleRange,
  }
}

function getChannelDisplayRange({
  channel,
  viewStart,
  viewEnd,
  plotWidth,
  channelYZoom,
  channelYRange,
}) {
  if (channel.isAnnotationChannel) {
    const minVal = 0
    const maxVal = channel.physicalMax > 0 ? channel.physicalMax : 1
    const override = channelYRange[channel.id]
    if (
      override &&
      Number.isFinite(override.min) &&
      Number.isFinite(override.max) &&
      override.min < override.max
    ) {
      return {
        displayMin: override.min,
        displayMax: override.max,
        displayRange: override.max - override.min,
        isCustom: true,
        samples: [],
      }
    }
    const yZoom = channelYZoom[channel.id] ?? DEFAULT_Y_ZOOM
    return {
      ...getVisibleValueRange(minVal, maxVal, yZoom),
      isCustom: false,
      samples: [],
    }
  }

  const startSample = viewStart * channel.sampleRate
  const endSample = viewEnd * channel.sampleRate
  const samples = downsampleRange(channel.data, startSample, endSample, plotWidth)

  if (samples.length === 0) {
    return {
      displayMin: 0,
      displayMax: 1,
      displayRange: 1,
      isCustom: false,
      samples,
    }
  }

  let minVal = Infinity
  let maxVal = -Infinity
  samples.forEach(({ min, max }) => {
    if (min < minVal) minVal = min
    if (max > maxVal) maxVal = max
  })

  const override = channelYRange[channel.id]
  if (
    override &&
    Number.isFinite(override.min) &&
    Number.isFinite(override.max) &&
    override.min < override.max
  ) {
    return {
      displayMin: override.min,
      displayMax: override.max,
      displayRange: override.max - override.min,
      isCustom: true,
      samples,
    }
  }

  const yZoom = channelYZoom[channel.id] ?? DEFAULT_Y_ZOOM
  const { displayMin, displayMax, displayRange } = getVisibleValueRange(minVal, maxVal, yZoom)
  return { displayMin, displayMax, displayRange, isCustom: false, samples }
}

function hexToRgba(hex, alpha) {
  const value = String(hex).replace('#', '')
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function buildDisplayStrips(channels, overlayGroups) {
  const asChannelStrip = (channel) => ({
    kind: 'channel',
    key: String(channel.id),
    channels: [channel],
    resizeChannelId: channel.id,
  })

  const visibleIds = new Set(channels.map((channel) => channel.id))
  const groups = sanitizeOverlayGroups(
    (overlayGroups ?? []).map((group) => group.filter((id) => visibleIds.has(id)))
  )
  if (groups.length === 0) {
    return channels.map(asChannelStrip)
  }

  const groupIndexByChannelId = new Map()
  groups.forEach((group, groupIndex) => {
    group.forEach((id) => groupIndexByChannelId.set(id, groupIndex))
  })

  const placedGroups = new Set()
  const strips = []

  channels.forEach((channel) => {
    const groupIndex = groupIndexByChannelId.get(channel.id)
    if (groupIndex === undefined) {
      strips.push(asChannelStrip(channel))
      return
    }
    if (placedGroups.has(groupIndex)) return
    placedGroups.add(groupIndex)

    const memberIds = new Set(groups[groupIndex])
    const members = channels.filter((item) => memberIds.has(item.id))
    if (members.length < 2) {
      members.forEach((member) => strips.push(asChannelStrip(member)))
      return
    }

    strips.push({
      kind: 'overlay',
      key: getOverlayRangeKey(members.map((member) => member.id)),
      channels: members,
      resizeChannelId: members[members.length - 1].id,
    })
  })

  return strips
}

function getDisplayStripHeight(strip, channelStripHeights) {
  return strip.channels.reduce(
    (sum, channel) => sum + getChannelStripHeight(channelStripHeights, channel.id),
    0
  )
}

function fitDisplayStripHeights(strips, channelStripHeights, targetPlotHeight) {
  if (strips.length === 0 || targetPlotHeight <= 0) return channelStripHeights

  const weights = strips.map((strip) => Math.max(1, getDisplayStripHeight(strip, channelStripHeights)))
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
  const next = { ...channelStripHeights }
  let assigned = 0

  strips.forEach((strip, stripIndex) => {
    const stripHeight = stripIndex === strips.length - 1
      ? Math.max(1, targetPlotHeight - assigned)
      : (weights[stripIndex] / weightSum) * targetPlotHeight
    if (stripIndex !== strips.length - 1) assigned += stripHeight

    const memberWeights = strip.channels.map((channel) => (
      Math.max(1, getChannelStripHeight(channelStripHeights, channel.id))
    ))
    const memberSum = memberWeights.reduce((sum, weight) => sum + weight, 0)
    let memberAssigned = 0

    strip.channels.forEach((channel, memberIndex) => {
      if (memberIndex === strip.channels.length - 1) {
        next[channel.id] = Math.max(1, stripHeight - memberAssigned)
        return
      }
      const height = (memberWeights[memberIndex] / memberSum) * stripHeight
      next[channel.id] = height
      memberAssigned += height
    })
  })

  return next
}

function channelColorIndex(channel, activeChannels) {
  const index = activeChannels.findIndex((item) => item.id === channel.id)
  return index >= 0 ? index : 0
}

function formatCursorTime(time, sampleRate) {
  if (!(sampleRate > 0)) return `${Number(time).toFixed(4)} s`
  const step = 1 / sampleRate
  const decimals = Math.min(3, Math.max(2, Math.ceil(-Math.log10(step) - 1e-9)))
  return `${time.toFixed(decimals)} s`
}

function formatSignalValue(value) {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs !== 0 && (abs < 0.01 || abs >= 10000)) return value.toExponential(2)
  if (abs >= 100) return value.toFixed(1)
  return value.toFixed(2)
}

function clampTraceY(y, yTop, yBottom) {
  return Math.max(yTop + 2, Math.min(yBottom - 2, y))
}

function detailTraceY(value, yBottom, stripHeight, displayMin, displayRange) {
  const range = displayRange || 1
  return yBottom - 8 - ((value - displayMin) / range) * (stripHeight - 16)
}

function overviewTraceY(value, yTop, stripHeight, displayMin, displayRange) {
  const plotTop = yTop + 4
  const plotBottom = yTop + stripHeight - 4
  const innerHeight = Math.max(plotBottom - plotTop, 1)
  const range = displayRange || 1
  return plotBottom - ((value - displayMin) / range) * innerHeight
}

function readNearestSample(data, time, sampleRate) {
  if (!data || data.length === 0) return null
  const index = timeToSampleIndex(time, sampleRate, data.length)
  const value = data[index]
  return Number.isFinite(value) ? value : null
}

function readSeriesRange(data) {
  const samples = downsampleRange(data, 0, data?.length ?? 0, 1000)
  let minVal = Infinity
  let maxVal = -Infinity
  samples.forEach(({ min, max }) => {
    if (min < minVal) minVal = min
    if (max > maxVal) maxVal = max
  })
  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
    return { displayMin: 0, displayRange: 1 }
  }
  return { displayMin: minVal, displayRange: maxVal - minVal || 1 }
}

function channelReadoutColor(channel, colorChannels) {
  return CHANNEL_COLORS[channelColorIndex(channel, colorChannels) % CHANNEL_COLORS.length]
}

function describeChannelValue(channel, time, options) {
  const {
    isBinary,
    data,
    display,
    yTop,
    yBottom,
    stripHeight,
    overview,
    colorChannels,
  } = options
  const color = channelReadoutColor(channel, colorChannels)

  if (channel.isAnnotationChannel) {
    const event = nearestAnnotationEvent(
      channel.events,
      time,
      channel.maxEventDuration ?? 0
    )
    const markerY = display && event
      ? clampTraceY(
        overview
          ? overviewTraceY(event.value, yTop, stripHeight, display.displayMin, display.displayRange)
          : detailTraceY(event.value, yBottom, stripHeight, display.displayMin, display.displayRange),
        yTop,
        yBottom
      )
      : null
    const text = event
      ? `${formatSignalValue(event.value)} at ${event.onset.toFixed(4)} s`
      : '—'
    return {
      key: channel.id,
      label: channel.label,
      text,
      color,
      markerY,
    }
  }

  const raw = readNearestSample(data, time, channel.sampleRate)

  if (isBinary) {
    return {
      key: channel.id,
      label: channel.label,
      text: raw === null ? '—' : (isActiveBinary(raw) ? '1' : '0'),
      color,
      markerY: null,
    }
  }

  const unit = channel.physicalDimension ? ` ${channel.physicalDimension}` : ''
  const markerY = display && raw !== null
    ? clampTraceY(
      overview
        ? overviewTraceY(raw, yTop, stripHeight, display.displayMin, display.displayRange)
        : detailTraceY(raw, yBottom, stripHeight, display.displayMin, display.displayRange),
      yTop,
      yBottom
    )
    : null

  return {
    key: channel.id,
    label: channel.label,
    text: `${formatSignalValue(raw)}${unit}`,
    color,
    markerY,
  }
}

function withMarkerPercents(rows, canvasHeight) {
  return rows.map((row) => ({
    ...row,
    markerTopPercent: row.markerY === null || canvasHeight <= 0
      ? null
      : (row.markerY / canvasHeight) * 100,
  }))
}

function buildHoverReadout(pointer, context, overviewRangeCache) {
  const { canvasX, canvasY, canvasWidth, canvasHeight } = pointer
  const labelWidth = context.plotLeft ?? PLOT_PADDING.left
  const plotWidth = canvasWidth - labelWidth - PLOT_PADDING.right
  const plotLeft = labelWidth + Y_VALUE_REGION_WIDTH
  const plotRight = canvasWidth - PLOT_PADDING.right
  if (plotWidth <= 0 || canvasHeight <= 0) return null
  if (canvasX < plotLeft || canvasX > plotRight) return null

  const fraction = Math.max(0, Math.min(1, (canvasX - labelWidth) / plotWidth))
  const {
    viewStart,
    viewEnd,
    totalDuration,
    displayStrips,
    stripHeights,
    overviewChannel,
    getChannelFormat,
    getMaskData,
    readDisplayRange,
    colorChannels,
  } = context

  const overviewTop = PLOT_PADDING.top
  const overviewBottom = getDetailChannelsTop()
  const onOverview = Boolean(
    overviewChannel && canvasY >= overviewTop && canvasY < overviewBottom
  )

  let yOffset = getDetailChannelsTop()
  let hoveredStrip = null
  displayStrips.forEach((strip) => {
    const height = getDisplayStripHeight(strip, stripHeights)
    const yTop = yOffset
    const yBottom = yTop + height
    if (!onOverview && !hoveredStrip && canvasY >= yTop && canvasY < yBottom) {
      hoveredStrip = { strip, yTop, yBottom, height }
    }
    yOffset = yBottom
  })

  if (!onOverview && !hoveredStrip) return null

  const xPercent = (canvasX / canvasWidth) * 100
  const placeLeft = canvasX > plotRight - 110

  if (onOverview) {
    const time = fraction * totalDuration
    const isBinary = getChannelFormat(overviewChannel.id) === DEPICTION_FORMATS.BINARY_MASK
    let display = null
    if (overviewChannel.isAnnotationChannel) {
      const peak = overviewChannel.physicalMax > 0 ? overviewChannel.physicalMax : 1
      display = { displayMin: 0, displayMax: peak, displayRange: peak }
    } else if (!isBinary) {
      const cacheKey = `${overviewChannel.id}:${overviewChannel.data?.length ?? 0}`
      if (overviewRangeCache.key !== cacheKey) {
        overviewRangeCache.key = cacheKey
        overviewRangeCache.display = readSeriesRange(overviewChannel.data ?? [])
      }
      display = overviewRangeCache.display
    }
    const row = describeChannelValue(overviewChannel, time, {
      isBinary,
      data: overviewChannel.data ?? [],
      display,
      yTop: overviewTop,
      yBottom: overviewBottom,
      stripHeight: OVERVIEW_STRIP_HEIGHT,
      overview: true,
      colorChannels,
    })
    return {
      xPercent,
      lineTopPercent: (overviewTop / canvasHeight) * 100,
      lineHeightPercent: (OVERVIEW_STRIP_HEIGHT / canvasHeight) * 100,
      timeLabel: formatCursorTime(time, overviewChannel.sampleRate),
      chipTopPercent: (canvasY / canvasHeight) * 100,
      placeLeft,
      showLabels: false,
      rows: withMarkerPercents([row], canvasHeight),
    }
  }

  const time = viewStart + fraction * Math.max(viewEnd - viewStart, 0)
  const { strip, yTop, yBottom, height } = hoveredStrip
  const rows = strip.kind === 'overlay'
    ? strip.channels.map((member) => {
      const isBinary = getChannelFormat(member.id) === DEPICTION_FORMATS.BINARY_MASK
      return describeChannelValue(member, time, {
        isBinary,
        data: getMaskData(member.id),
        display: isBinary ? null : readDisplayRange(strip.key),
        yTop,
        yBottom,
        stripHeight: height,
        overview: false,
        colorChannels,
      })
    })
    : (() => {
      const channel = strip.channels[0]
      const isBinary = getChannelFormat(channel.id) === DEPICTION_FORMATS.BINARY_MASK
      return [describeChannelValue(channel, time, {
        isBinary,
        data: isBinary ? getMaskData(channel.id) : (channel.data ?? []),
        display: isBinary ? null : readDisplayRange(channel.id),
        yTop,
        yBottom,
        stripHeight: height,
        overview: false,
        colorChannels,
      })]
    })()
  const sampleRate = Math.max(...strip.channels.map((channel) => channel.sampleRate || 0))
  const detailTop = getDetailChannelsTop()

  return {
    xPercent,
    lineTopPercent: (detailTop / canvasHeight) * 100,
    lineHeightPercent: (Math.max(yOffset - detailTop, 0) / canvasHeight) * 100,
    timeLabel: formatCursorTime(time, sampleRate),
    chipTopPercent: (canvasY / canvasHeight) * 100,
    placeLeft,
    showLabels: strip.kind === 'overlay',
    rows: withMarkerPercents(rows, canvasHeight),
  }
}

function SignalHoverOverlay({
  wrapRef,
  canvasRef,
  dragStateRef,
  maskEditDragRef,
  contextRef,
}) {
  const [readout, setReadout] = useState(null)
  const overviewRangeCacheRef = useRef({ key: '', display: null })

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return undefined

    const updateFromPointer = (event) => {
      if (dragStateRef.current || maskEditDragRef.current) {
        setReadout((prev) => (prev ? null : prev))
        return
      }

      const canvas = canvasRef.current
      const context = contextRef.current
      if (!canvas || !context || canvas.width <= 0 || canvas.height <= 0) {
        setReadout((prev) => (prev ? null : prev))
        return
      }

      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        setReadout((prev) => (prev ? null : prev))
        return
      }

      const canvasX = ((event.clientX - rect.left) / rect.width) * canvas.width
      const canvasY = ((event.clientY - rect.top) / rect.height) * canvas.height
      const next = buildHoverReadout(
        { canvasX, canvasY, canvasWidth: canvas.width, canvasHeight: canvas.height },
        context,
        overviewRangeCacheRef.current
      )
      setReadout((prev) => (next || prev ? next : prev))
    }

    const clearReadout = () => setReadout((prev) => (prev ? null : prev))

    wrap.addEventListener('pointermove', updateFromPointer)
    wrap.addEventListener('pointerleave', clearReadout)
    return () => {
      wrap.removeEventListener('pointermove', updateFromPointer)
      wrap.removeEventListener('pointerleave', clearReadout)
    }
  }, [wrapRef, canvasRef, dragStateRef, maskEditDragRef, contextRef])

  if (!readout) return null

  return (
    <div className="signal-hover-overlay" aria-hidden="true">
      <div
        className="signal-hover-line"
        style={{
          left: `${readout.xPercent}%`,
          top: `${readout.lineTopPercent}%`,
          height: `${readout.lineHeightPercent}%`,
        }}
      />
      <div
        className={`signal-hover-time${readout.placeLeft ? ' signal-hover-flip' : ''}`}
        style={{
          left: `${readout.xPercent}%`,
          top: `${readout.lineTopPercent}%`,
        }}
      >
        {readout.timeLabel}
      </div>
      {readout.rows.map((row) => (
        row.markerTopPercent === null ? null : (
          <div
            key={`marker-${row.key}`}
            className="signal-hover-marker"
            style={{
              left: `${readout.xPercent}%`,
              top: `${row.markerTopPercent}%`,
              background: row.color,
            }}
          />
        )
      ))}
      <div
        className={`signal-hover-chip${readout.placeLeft ? ' signal-hover-flip' : ''}`}
        style={{
          left: `${readout.xPercent}%`,
          top: `${readout.chipTopPercent}%`,
        }}
      >
        {readout.rows.map((row) => (
          <div key={`value-${row.key}`} className="signal-hover-chip-row">
            {readout.showLabels ? (
              <span className="signal-hover-chip-label">{row.label}</span>
            ) : null}
            <span style={{ color: row.color }}>{row.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function clipToChannelStrip(ctx, xLeft, plotWidth, yTop, stripHeight) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(xLeft, yTop, plotWidth, stripHeight)
  ctx.clip()
}

function getChannelStripLayouts(activeChannels, channelStripHeights, canvasHeight) {
  if (activeChannels.length === 0 || canvasHeight <= 0) return []

  let offset = getDetailChannelsTop()
  return activeChannels.map((channel) => {
    const height = getChannelStripHeight(channelStripHeights, channel.id)
    const layout = {
      channel,
      topPercent: (offset / canvasHeight) * 100,
      heightPercent: (height / canvasHeight) * 100,
    }
    offset += height
    return layout
  })
}

function getOverviewStripLayout(canvasHeight) {
  if (canvasHeight <= 0) return null

  return {
    topPercent: (PLOT_PADDING.top / canvasHeight) * 100,
    heightPercent: (OVERVIEW_STRIP_HEIGHT / canvasHeight) * 100,
  }
}

function getChannelBoundaryPercents(activeChannels, channelStripHeights, canvasHeight) {
  if (activeChannels.length < 2 || canvasHeight <= 0) return []

  let offset = getDetailChannelsTop()
  const boundaries = []

  for (let i = 0; i < activeChannels.length - 1; i += 1) {
    offset += getChannelStripHeight(channelStripHeights, activeChannels[i].id)
    boundaries.push({
      channelIndex: i,
      percent: (offset / canvasHeight) * 100,
    })
  }

  return boundaries
}

function getLastChannelBottomPercent(activeChannels, channelStripHeights, canvasHeight) {
  if (activeChannels.length === 0 || canvasHeight <= 0) return null

  let offset = getDetailChannelsTop()
  activeChannels.forEach((channel) => {
    offset += getChannelStripHeight(channelStripHeights, channel.id)
  })

  return (offset / canvasHeight) * 100
}

function downsampleRange(data, startIndex, endIndex, targetPoints) {
  const start = Math.max(0, Math.floor(startIndex))
  const end = Math.min(data.length, Math.ceil(endIndex))
  const length = end - start
  if (length <= 0) return []

  const points = Math.max(0, Math.min(Math.floor(targetPoints) || 0, length))
  if (points <= 0) return []
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

function mapIdsToLabels(idRecord, channelById) {
  const byLabel = {}
  Object.entries(idRecord ?? {}).forEach(([id, value]) => {
    if (isOverlayRangeKey(id)) return
    const label = channelById[id]?.label ?? channelById[Number(id)]?.label
    if (label) byLabel[label] = value
  })
  return byLabel
}

function isFixedDisplayRange(range) {
  return Boolean(
    range
    && Number.isFinite(range.min)
    && Number.isFinite(range.max)
    && range.min < range.max
  )
}

function overlayMemberIdsFromKey(key) {
  if (typeof key !== 'string' || !key.startsWith(OVERLAY_RANGE_PREFIX)) return null
  const memberIds = key.slice(OVERLAY_RANGE_PREFIX.length).split(',').map(Number)
  if (memberIds.length < 2 || memberIds.some((id) => !Number.isFinite(id))) return null
  return memberIds
}

function mapOverlayStripYRanges(channelYRange, channelById) {
  const ranges = []
  Object.entries(channelYRange ?? {}).forEach(([key, range]) => {
    const memberIds = overlayMemberIdsFromKey(key)
    if (!memberIds || !isFixedDisplayRange(range)) return
    const labels = memberIds.map((id) => channelById[id]?.label)
    if (labels.some((label) => !label)) return
    ranges.push({
      labels: [...labels].sort((a, b) => a.localeCompare(b)),
      min: range.min,
      max: range.max,
    })
  })
  return ranges.sort((a, b) => a.labels.join('\0').localeCompare(b.labels.join('\0')))
}

function normalizeOverlayStripYRanges(ranges) {
  return (ranges ?? [])
    .map((entry) => ({
      labels: [...(entry?.labels ?? [])].filter(Boolean).sort((a, b) => a.localeCompare(b)),
      min: entry?.min,
      max: entry?.max,
    }))
    .filter((entry) => entry.labels.length >= 2 && isFixedDisplayRange(entry))
    .sort((a, b) => a.labels.join('\0').localeCompare(b.labels.join('\0')))
}

function resolveOverlayStripYRanges(ranges, labelToId, overlayGroups) {
  const resolved = {}
  normalizeOverlayStripYRanges(ranges).forEach((entry) => {
    const ids = entry.labels.map((label) => labelToId[label])
    if (ids.some((id) => id === undefined)) return
    const key = getOverlayRangeKey(ids)
    const matchesGroup = overlayGroups.some((group) => getOverlayRangeKey(group) === key)
    if (!matchesGroup) return
    resolved[key] = { min: entry.min, max: entry.max }
  })
  return resolved
}

function normalizeChannelLabelRecord(record) {
  return Object.fromEntries(
    Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b))
  )
}

function normalizeOverlayChannelGroups(groups, legacyLabels, composeMode) {
  if (Array.isArray(groups) && groups.length > 0) {
    return groups
      .map((group) => [...(group ?? [])].filter(Boolean).sort((a, b) => a.localeCompare(b)))
      .filter((group) => group.length >= 2)
      .sort((a, b) => a.join('\0').localeCompare(b.join('\0')))
  }

  if (composeMode === COMPOSE_MODES.OVERLAY) {
    const legacy = [...(legacyLabels ?? [])].filter(Boolean).sort((a, b) => a.localeCompare(b))
    return legacy.length >= 2 ? [legacy] : []
  }

  return []
}

function resolveOverlayGroupsFromParams(params, labelToId) {
  if (Array.isArray(params.overlayChannelGroups) && params.overlayChannelGroups.length > 0) {
    return sanitizeOverlayGroups(
      params.overlayChannelGroups.map((group) => (
        (group ?? [])
          .map((label) => labelToId[label])
          .filter((id) => id !== undefined)
      ))
    )
  }

  if (params.composeMode === COMPOSE_MODES.OVERLAY) {
    return sanitizeOverlayGroups([[
      ...(params.overlayChannelLabels ?? [])
        .map((label) => labelToId[label])
        .filter((id) => id !== undefined),
    ]])
  }

  return []
}

function buildViewParams({
  edfData,
  selectedChannels,
  channelFormats,
  binaryMaskOverlays,
  channelStripHeights,
  channelYZoom,
  channelYRange,
  overviewChannelId,
  windowSeconds,
  viewStart,
  panelHeight,
  activeTab,
  annotationGroups,
  allChannels,
  overlayGroups,
}) {
  const channelById = Object.fromEntries(
    (allChannels ?? [...edfData.channels]).map((ch) => [ch.id, ch])
  )

  const selectedChannelLabels = selectedChannels
    .map((id) => channelById[id]?.label)
    .filter(Boolean)

  const channelFormatsByLabel = {}
  Object.entries(channelFormats).forEach(([id, format]) => {
    const label = channelById[Number(id)]?.label ?? channelById[id]?.label
    if (label) channelFormatsByLabel[label] = format
  })

  const resolvedOverlays = { ...binaryMaskOverlays }
  selectedChannels.forEach((id) => {
    if ((channelFormats[id] ?? DEPICTION_FORMATS.SEQUENCE) !== DEPICTION_FORMATS.BINARY_MASK) return
    if (!resolvedOverlays[id]?.length) {
      resolvedOverlays[id] = getDefaultBinaryMaskOverlayTargets(id, selectedChannels, channelFormats)
    }
  })

  const uniqueLabels = getUniqueAnnotationLabels(edfData.annotations ?? [])
  const normalizedGroups = normalizeAnnotationGroups(annotationGroups, uniqueLabels)
  const overlayChannelGroups = sanitizeOverlayGroups(overlayGroups)
    .map((group) => group.map((id) => channelById[id]?.label).filter(Boolean))
    .filter((group) => group.length >= 2)
  const primaryOverlayLabels = overlayChannelGroups[0] ?? []

  return {
    selectedChannelLabels,
    channelDisplayOrderLabels: selectedChannelLabels,
    overviewChannelLabel: channelById[overviewChannelId]?.label ?? null,
    channelFormats: channelFormatsByLabel,
    binaryMaskOverlaysByLabel: mapOverlayIdsToLabels(resolvedOverlays, channelById),
    channelStripHeightsByLabel: mapIdsToLabels(channelStripHeights, channelById),
    channelYZoomByLabel: mapIdsToLabels(channelYZoom, channelById),
    channelYRangeByLabel: mapIdsToLabels(channelYRange, channelById),
    overlayStripYRanges: mapOverlayStripYRanges(channelYRange, channelById),
    annotationGroups: serializeAnnotationGroups(normalizedGroups),
    windowSeconds,
    viewStart,
    panelHeight,
    activeTab,
    overlayChannelGroups,
    // Legacy single-group fields kept for older preset readers.
    overlayChannelLabels: primaryOverlayLabels,
    composeMode: overlayChannelGroups.length > 0 ? COMPOSE_MODES.OVERLAY : COMPOSE_MODES.BACKDROP,
  }
}

function resolveActiveTab(params) {
  if (params.activeTab && Object.values(VIEWER_TABS).includes(params.activeTab)) {
    return params.activeTab
  }
  return params.channelPanelOpen === false ? VIEWER_TABS.VIEWER : VIEWER_TABS.CHANNELS
}

function normalizeViewParams(params) {
  const channelDisplayOrderLabels = [
    ...(params.channelDisplayOrderLabels ?? params.selectedChannelLabels ?? []),
  ]

  return {
    selectedChannelLabels: [...(params.selectedChannelLabels ?? [])],
    channelDisplayOrderLabels,
    overviewChannelLabel: params.overviewChannelLabel ?? null,
    channelFormats: normalizeChannelLabelRecord(params.channelFormats),
    binaryMaskOverlaysByLabel: normalizeOverlayLabelRecord(params.binaryMaskOverlaysByLabel),
    channelStripHeightsByLabel: normalizeChannelLabelRecord(params.channelStripHeightsByLabel),
    channelYZoomByLabel: normalizeChannelLabelRecord(params.channelYZoomByLabel),
    channelYRangeByLabel: normalizeChannelLabelRecord(params.channelYRangeByLabel),
    overlayStripYRanges: normalizeOverlayStripYRanges(params.overlayStripYRanges),
    annotationGroups: serializeAnnotationGroups(params.annotationGroups ?? []),
    windowSeconds: params.windowSeconds,
    viewStart: params.viewStart,
    panelHeight: params.panelHeight ?? DEFAULT_PANEL_HEIGHT,
    activeTab: resolveActiveTab(params),
    overlayChannelGroups: normalizeOverlayChannelGroups(
      params.overlayChannelGroups,
      params.overlayChannelLabels,
      params.composeMode
    ),
  }
}

function resolveFullViewParams(params, edfData, totalDuration) {
  const applied = applyViewParams(params, edfData, totalDuration)
  return buildViewParams({
    edfData,
    selectedChannels: applied.selectedChannels,
    channelFormats: applied.channelFormats,
    binaryMaskOverlays: applied.binaryMaskOverlays,
    channelStripHeights: applied.channelStripHeights,
    channelYZoom: applied.channelYZoom,
    channelYRange: applied.channelYRange,
    overviewChannelId: applied.overviewChannelId,
    windowSeconds: applied.windowSeconds,
    viewStart: applied.viewStart,
    panelHeight: applied.panelHeight,
    activeTab: applied.activeTab,
    annotationGroups: applied.annotationGroups,
    allChannels: applied.allChannels,
    overlayGroups: applied.overlayGroups,
  })
}

function areViewParamsEqual(a, b, edfData, totalDuration) {
  const resolvedA = normalizeViewParams(resolveFullViewParams(a, edfData, totalDuration))
  const resolvedB = normalizeViewParams(resolveFullViewParams(b, edfData, totalDuration))
  return JSON.stringify(resolvedA) === JSON.stringify(resolvedB)
}

function applyViewParams(params, edfData, totalDuration) {
  const { groups, allChannels } = resolveAnnotationBundle(
    edfData,
    params.annotationGroups,
    totalDuration
  )
  const labelToId = Object.fromEntries(allChannels.map((ch) => [ch.label, ch.id]))
  const binaryChannelIds = new Set(
    allChannels.filter((ch) => isBinarySignal(ch.data)).map((ch) => ch.id)
  )

  const orderLabels = (params.channelDisplayOrderLabels?.length
    ? params.channelDisplayOrderLabels
    : params.selectedChannelLabels) ?? []

  const selected = orderLabels
    .map((label) => labelToId[label])
    .filter((id) => id !== undefined)

  const formats = {}
  Object.entries(params.channelFormats ?? {}).forEach(([label, format]) => {
    const id = labelToId[label]
    if (id === undefined) return
    const channel = allChannels.find((item) => item.id === id)
    if (format === DEPICTION_FORMATS.STEM && !channel?.isAnnotationChannel) return
    if (channel?.isAnnotationChannel && format !== DEPICTION_FORMATS.STEM) return
    if (format === DEPICTION_FORMATS.BINARY_MASK && !binaryChannelIds.has(id)) return
    formats[id] = format
  })

  const binaryMaskOverlays = {}
  Object.entries(params.binaryMaskOverlaysByLabel ?? {}).forEach(([maskLabel, targetLabels]) => {
    const maskId = labelToId[maskLabel]
    if (maskId === undefined) return
    const maskChannel = allChannels.find((item) => item.id === maskId)
    const format = formats[maskId] ?? defaultDepictionFormat(maskChannel)
    if (format !== DEPICTION_FORMATS.BINARY_MASK && format !== DEPICTION_FORMATS.STEM) return

    const targetIds = (targetLabels ?? [])
      .map((label) => labelToId[label])
      .filter((id) => id !== undefined && id !== maskId)

    if (targetIds.length > 0) {
      binaryMaskOverlays[maskId] = targetIds
    }
  })

  const stripHeights = {}
  Object.entries(params.channelStripHeightsByLabel ?? {}).forEach(([label, height]) => {
    const id = labelToId[label]
    if (id === undefined) return
    stripHeights[id] = Math.max(MIN_CHANNEL_STRIP_HEIGHT, height)
  })

  const yZoom = {}
  Object.entries(params.channelYZoomByLabel ?? {}).forEach(([label, zoom]) => {
    const id = labelToId[label]
    if (id === undefined) return
    yZoom[id] = Math.max(MIN_Y_ZOOM, Math.min(MAX_Y_ZOOM, zoom))
  })

  const yRange = {}
  Object.entries(params.channelYRangeByLabel ?? {}).forEach(([label, range]) => {
    const id = labelToId[label]
    if (id === undefined || !range) return
    if (
      Number.isFinite(range.min) &&
      Number.isFinite(range.max) &&
      range.min < range.max
    ) {
      yRange[id] = { min: range.min, max: range.max }
    }
  })

  const nextWindowSeconds = Math.max(
    MIN_WINDOW_SECONDS,
    Math.min(totalDuration, params.windowSeconds ?? 60)
  )
  const nextViewStart = clampViewStart(
    params.viewStart ?? 0,
    nextWindowSeconds,
    totalDuration
  )

  const selectedChannelsResult = selected.length > 0 ? selected : getDefaultSelection(allChannels)

  let overviewChannelId = params.overviewChannelLabel
    ? labelToId[params.overviewChannelLabel]
    : undefined
  if (overviewChannelId === undefined) {
    overviewChannelId = getDefaultOverviewChannelId(allChannels, selectedChannelsResult)
  }

  const overlayGroups = resolveOverlayGroupsFromParams(params, labelToId)
  Object.assign(yRange, resolveOverlayStripYRanges(params.overlayStripYRanges, labelToId, overlayGroups))

  Object.entries(formats).forEach(([id, format]) => {
    if (format !== DEPICTION_FORMATS.BINARY_MASK) return
    const channelId = Number(id)
    if (!binaryMaskOverlays[channelId]?.length) {
      binaryMaskOverlays[channelId] = getDefaultBinaryMaskOverlayTargets(
        channelId,
        selectedChannelsResult,
        formats
      )
    }
  })

  return {
    selectedChannels: selectedChannelsResult,
    channelFormats: formats,
    binaryMaskOverlays,
    channelStripHeights: stripHeights,
    channelYZoom: yZoom,
    channelYRange: yRange,
    overviewChannelId,
    windowSeconds: nextWindowSeconds,
    viewStart: nextViewStart,
    panelHeight: Math.max(MIN_PANEL_HEIGHT, params.panelHeight ?? DEFAULT_PANEL_HEIGHT),
    activeTab: resolveActiveTab(params),
    annotationGroups: groups,
    allChannels,
    overlayGroups,
  }
}

const SignalViewer = ({ edfData, onBack }) => {
  const canvasRef = useRef(null)
  const canvasWrapRef = useRef(null)
  const containerRef = useRef(null)
  const overviewStripRef = useRef(null)
  const totalDuration = edfData.totalDuration
  const uniqueAnnotationLabels = useMemo(
    () => getUniqueAnnotationLabels(edfData.annotations ?? []),
    [edfData.annotations]
  )

  const [annotationGroups, setAnnotationGroups] = useState(() =>
    buildDefaultAnnotationGroups(getUniqueAnnotationLabels(edfData.annotations ?? []))
  )
  const [draftAnnotationGroups, setDraftAnnotationGroups] = useState(null)
  const [selectedChannels, setSelectedChannels] = useState(() =>
    getDefaultSelection(edfData.channels)
  )
  const [channelFormats, setChannelFormats] = useState({})
  const [binaryMaskOverlays, setBinaryMaskOverlays] = useState({})
  const [windowSeconds, setWindowSeconds] = useState(60)
  const [viewStart, setViewStart] = useState(0)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 400 })
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT)
  const [panelFillsWindow, setPanelFillsWindow] = useState(false)
  const [channelLabelWidth, setChannelLabelWidth] = useState(DEFAULT_CHANNEL_LABEL_WIDTH)
  const [manipulationIds, setManipulationIds] = useState([])
  const [temporaryChannelIds, setTemporaryChannelIds] = useState(null)
  const [overlayGroups, setOverlayGroups] = useState([])
  const [compareMode, setCompareMode] = useState(false)
  const [channelStripHeights, setChannelStripHeights] = useState({})
  const [channelYZoom, setChannelYZoom] = useState({})
  const [channelYRange, setChannelYRange] = useState({})
  const [overviewChannelId, setOverviewChannelId] = useState(() =>
    getDefaultOverviewChannelId(edfData.channels, getDefaultSelection(edfData.channels))
  )
  const [activeTab, setActiveTab] = useState(VIEWER_TABS.VIEWER)
  const [importedChannels, setImportedChannels] = useState([])
  const [removedPersistedChannelIds, setRemovedPersistedChannelIds] = useState([])
  const [importSampleRate, setImportSampleRate] = useState('')
  const [pendingImportColumns, setPendingImportColumns] = useState([])
  const [importError, setImportError] = useState('')
  const [isLoadingParquet, setIsLoadingParquet] = useState(false)
  const nextImportedIdRef = useRef(PARQUET_CHANNEL_ID_BASE)
  const pendingImportKeyRef = useRef(0)
  const [savedPresets, setSavedPresets] = useState([])
  const [presetName, setPresetName] = useState('')
  const [presetMessage, setPresetMessage] = useState('')
  const [presetError, setPresetError] = useState('')
  const [presetsLoading, setPresetsLoading] = useState(true)
  const [loadedPresetId, setLoadedPresetId] = useState(null)
  const [reorderingChannelId, setReorderingChannelId] = useState(null)
  const [panningYCenterChannelId, setPanningYCenterChannelId] = useState(null)
  const [yRangeDialog, setYRangeDialog] = useState(null)
  const [edfSaveMessage, setEdfSaveMessage] = useState('')
  const [edfSaveError, setEdfSaveError] = useState('')
  const [isSavingEdf, setIsSavingEdf] = useState(false)
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)
  const [saveConflict, setSaveConflict] = useState(null)
  const [savedRecordId, setSavedRecordId] = useState(edfData.savedRecordId ?? null)
  const [maskOverrides, setMaskOverrides] = useState({})
  const [maskSelection, setMaskSelection] = useState(null)
  const [maskHistory, setMaskHistory] = useState([])

  const viewEnd = Math.min(viewStart + windowSeconds, totalDuration)

  const annotationGroupsRef = useRef(annotationGroups)
  const draftAnnotationGroupsRef = useRef(draftAnnotationGroups)

  useEffect(() => {
    annotationGroupsRef.current = annotationGroups
  }, [annotationGroups])

  useEffect(() => {
    draftAnnotationGroupsRef.current = draftAnnotationGroups
  }, [draftAnnotationGroups])

  const displayAnnotationGroups = draftAnnotationGroups ?? annotationGroups

  const annotationChannels = useMemo(
    () =>
      buildAnnotationChannels(
        edfData.annotations ?? [],
        totalDuration,
        annotationGroups
      ),
    [edfData.annotations, totalDuration, annotationGroups]
  )

  const visibleFileChannels = useMemo(
    () => edfData.channels.filter((channel) => !removedPersistedChannelIds.includes(channel.id)),
    [edfData.channels, removedPersistedChannelIds]
  )

  const allChannels = useMemo(
    () => [...visibleFileChannels, ...annotationChannels, ...importedChannels],
    [visibleFileChannels, annotationChannels, importedChannels]
  )

  const channelById = useMemo(
    () => Object.fromEntries(allChannels.map((ch) => [ch.id, ch])),
    [allChannels]
  )

  const channelByIdRef = useRef(channelById)

  useEffect(() => {
    channelByIdRef.current = channelById
  }, [channelById])

  const activeChannels = useMemo(
    () => selectedChannels.map((id) => channelById[id]).filter(Boolean),
    [selectedChannels, channelById]
  )

  const drawnChannelIds = temporaryChannelIds ?? selectedChannels

  const drawnChannels = useMemo(
    () => drawnChannelIds.map((id) => channelById[id]).filter(Boolean),
    [drawnChannelIds, channelById]
  )

  const physiologicalChannelsForList = useMemo(() => {
    const selectedSet = new Set(selectedChannels)
    const selectedOrdered = selectedChannels
      .map((id) => channelById[id])
      .filter((ch) => ch && !ch.isAnnotationChannel && !ch.isImported)
    const unselected = visibleFileChannels.filter((ch) => !selectedSet.has(ch.id) && !ch.isImported)
    return [...selectedOrdered, ...unselected]
  }, [visibleFileChannels, selectedChannels, channelById])

  const annotationItemsForList = useMemo(() => {
    const items = displayAnnotationGroups.map((group, groupIndex) => {
      const committed = annotationGroups[groupIndex]
      const channel =
        (committed
          ? annotationChannels.find((ch) => ch.label === committed.name)
          : null) ??
        annotationChannels.find((ch) => ch.label === group.name) ??
        null
      return { group, groupIndex, channel }
    })
    const selectedOrdered = selectedChannels
      .map((id) => items.find((item) => item.channel?.id === id))
      .filter(Boolean)
    const selectedKeys = new Set(
      selectedOrdered.map((item) => `${item.groupIndex}:${item.group.name}`)
    )
    const rest = items.filter(
      (item) => !selectedKeys.has(`${item.groupIndex}:${item.group.name}`)
    )
    return [...selectedOrdered, ...rest]
  }, [displayAnnotationGroups, annotationGroups, annotationChannels, selectedChannels])

  const importedChannelsForList = useMemo(() => {
    const selectedSet = new Set(selectedChannels)
    const persistedImported = visibleFileChannels.filter((channel) => channel.isImported)
    const sessionIds = new Set(importedChannels.map((channel) => channel.id))
    const selectedOrdered = selectedChannels
      .map((id) => channelById[id])
      .filter((channel) => channel?.isImported)
    const unselected = [
      ...persistedImported.filter((channel) => !sessionIds.has(channel.id) && !selectedSet.has(channel.id)),
      ...importedChannels.filter((channel) => !selectedSet.has(channel.id)),
    ]
    return [...selectedOrdered, ...unselected]
  }, [visibleFileChannels, importedChannels, selectedChannels, channelById])

  const pendingImportFileCount = useMemo(
    () => new Set(pendingImportColumns.map((column) => column.fileName)).size,
    [pendingImportColumns]
  )

  const canvasHeight = useMemo(
    () => getCanvasHeightForPanel(panelHeight),
    [panelHeight]
  )

  const activeChannelKey = useMemo(
    () => activeChannels.map((channel) => channel.id).join(','),
    [activeChannels]
  )

  const displayStrips = useMemo(
    () => buildDisplayStrips(drawnChannels, overlayGroups),
    [drawnChannels, overlayGroups]
  )

  const compareChannels = useMemo(() => {
    const sourceIds = manipulationIds.length > 0
      ? manipulationIds
      : overlayGroups.flat()
    return sourceIds.map((id) => {
      const channel = channelById[id]
      if (!channel) return null
      const colorIndex = Math.max(0, drawnChannels.findIndex((item) => item.id === channel.id))
      return {
        id: channel.id,
        label: channel.isImported ? `${channel.label} (imported)` : channel.label,
        sampleRate: channel.sampleRate,
        data: maskOverrides[id] ?? channel.data ?? [],
        isMask: (channelFormats[id] ?? defaultDepictionFormat(channel)) === DEPICTION_FORMATS.BINARY_MASK,
        isStem: (channelFormats[id] ?? defaultDepictionFormat(channel)) === DEPICTION_FORMATS.STEM,
        events: channel.events ?? [],
        maxEventDuration: channel.maxEventDuration ?? 0,
        physicalMax: channel.physicalMax,
        color: CHANNEL_COLORS[colorIndex % CHANNEL_COLORS.length],
      }
    }).filter(Boolean)
  }, [manipulationIds, overlayGroups, channelById, drawnChannels, channelFormats, maskOverrides])

  const compareShareScale = useMemo(() => {
    const ids = compareChannels.map((channel) => channel.id)
    return findMatchingOverlayGroupIndex(overlayGroups, ids) >= 0
  }, [compareChannels, overlayGroups])

  const layoutStripHeights = useMemo(() => {
    if (temporaryChannelIds === null) return channelStripHeights
    return fitDisplayStripHeights(
      displayStrips,
      channelStripHeights,
      getPlotHeightForPanel(panelHeight)
    )
  }, [temporaryChannelIds, displayStrips, channelStripHeights, panelHeight])

  const manipulationSet = useMemo(() => new Set(manipulationIds), [manipulationIds])

  const channelBoundaries = useMemo(
    () => getChannelBoundaryPercents(activeChannels, channelStripHeights, canvasHeight),
    [activeChannels, channelStripHeights, canvasHeight]
  )

  const lastChannelBottomPercent = useMemo(
    () => getLastChannelBottomPercent(activeChannels, channelStripHeights, canvasHeight),
    [activeChannels, channelStripHeights, canvasHeight]
  )

  const channelStripLayouts = useMemo(
    () => getChannelStripLayouts(activeChannels, channelStripHeights, canvasHeight),
    [activeChannels, channelStripHeights, canvasHeight]
  )

  const displayStripLayouts = useMemo(() => {
    if (displayStrips.length === 0 || canvasHeight <= 0) return []

    let offset = getDetailChannelsTop()
    return displayStrips.map((strip) => {
      const height = getDisplayStripHeight(strip, layoutStripHeights)
      const layout = {
        strip,
        topPercent: (offset / canvasHeight) * 100,
        heightPercent: (height / canvasHeight) * 100,
      }
      offset += height
      return layout
    })
  }, [displayStrips, layoutStripHeights, canvasHeight])

  const displayBoundaries = useMemo(
    () => displayStripLayouts.slice(0, -1).map((layout, stripIndex) => ({
      stripIndex,
      percent: layout.topPercent + layout.heightPercent,
    })),
    [displayStripLayouts]
  )

  const displayLastBottomPercent = useMemo(() => {
    const last = displayStripLayouts[displayStripLayouts.length - 1]
    if (!last) return null
    return last.topPercent + last.heightPercent
  }, [displayStripLayouts])

  const overviewStripLayout = useMemo(
    () => getOverviewStripLayout(canvasHeight),
    [canvasHeight]
  )

  const overviewChannel = useMemo(() => {
    if (overviewChannelId !== null && channelById[overviewChannelId]) {
      return channelById[overviewChannelId]
    }
    const fallbackId = getDefaultOverviewChannelId(allChannels, selectedChannels)
    return fallbackId !== null ? channelById[fallbackId] ?? null : null
  }, [overviewChannelId, channelById, allChannels, selectedChannels])

  const displayStripsRef = useRef(displayStrips)
  const overlayGroupsRef = useRef(overlayGroups)

  useEffect(() => {
    displayStripsRef.current = displayStrips
  }, [displayStrips])

  useEffect(() => {
    overlayGroupsRef.current = overlayGroups
  }, [overlayGroups])

  useEffect(() => {
    const visible = new Set(selectedChannels)
    setOverlayGroups((prev) => {
      const next = sanitizeOverlayGroups(prev.map((group) => group.filter((id) => visible.has(id))))
      return overlayGroupsEqual(prev, next) ? prev : next
    })
  }, [selectedChannels])

  useEffect(() => {
    const validKeys = new Set(overlayGroups.map((group) => getOverlayRangeKey(group)))
    const pruneOverlayKeys = (prev) => {
      let changed = false
      const next = { ...prev }
      Object.keys(next).forEach((key) => {
        if (isOverlayRangeKey(key) && !validKeys.has(key)) {
          delete next[key]
          changed = true
        }
      })
      return changed ? next : prev
    }
    setChannelYZoom(pruneOverlayKeys)
    setChannelYRange(pruneOverlayKeys)
  }, [overlayGroups])

  const selectedChannelKey = selectedChannels.join(',')

  useEffect(() => {
    setTemporaryChannelIds(null)
  }, [selectedChannelKey])

  useEffect(() => {
    const visible = new Set(temporaryChannelIds ?? selectedChannels)
    setManipulationIds((prev) => {
      const next = prev.filter((id) => visible.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [temporaryChannelIds, selectedChannels])

  const previousAllChannelsRef = useRef(allChannels)

  useEffect(() => {
    const previous = previousAllChannelsRef.current
    previousAllChannelsRef.current = allChannels
    if (previous === allChannels) return

    const nextIds = new Set(allChannels.map((ch) => ch.id))
    const labelOf = (channels, id) => channels.find((ch) => ch.id === Number(id))?.label
    const idForLabel = (channels, label) => channels.find((ch) => ch.label === label)?.id

    setSelectedChannels((prev) => {
      if (prev.every((id) => nextIds.has(id))) return prev
      return remapSelectedChannelIds(prev, previous, allChannels)
    })

    setChannelFormats((prev) => {
      const entries = Object.entries(prev)
      if (entries.every(([id]) => nextIds.has(Number(id)))) return prev
      const next = {}
      entries.forEach(([id, format]) => {
        const label = labelOf(previous, id)
        const nextId = label ? idForLabel(allChannels, label) : undefined
        if (nextId !== undefined) next[nextId] = format
      })
      return next
    })

    setBinaryMaskOverlays((prev) => {
      const entries = Object.entries(prev)
      if (entries.every(([maskId]) => nextIds.has(Number(maskId)))) return prev
      const next = {}
      entries.forEach(([maskId, targets]) => {
        const maskLabel = labelOf(previous, maskId)
        const nextMaskId = maskLabel ? idForLabel(allChannels, maskLabel) : undefined
        if (nextMaskId === undefined) return
        next[nextMaskId] = (targets ?? [])
          .map((targetId) => {
            const targetLabel = labelOf(previous, targetId)
            return targetLabel ? idForLabel(allChannels, targetLabel) : undefined
          })
          .filter((id) => id !== undefined)
      })
      return next
    })

    const remapIdRecord = (prev, { allowOverlayKeys = false } = {}) => {
      const entries = Object.entries(prev)
      const needsRemap = entries.some(([id]) => {
        if (allowOverlayKeys && isOverlayRangeKey(id)) {
          if (id === LEGACY_OVERLAY_RANGE_KEY) return true
          const memberIds = id.slice(OVERLAY_RANGE_PREFIX.length).split(',').map(Number)
          return memberIds.some((memberId) => !nextIds.has(memberId))
        }
        return !nextIds.has(Number(id))
      })
      if (!needsRemap) return prev

      const next = {}
      entries.forEach(([id, value]) => {
        if (allowOverlayKeys && isOverlayRangeKey(id)) {
          if (id === LEGACY_OVERLAY_RANGE_KEY) return
          const memberIds = id.slice(OVERLAY_RANGE_PREFIX.length).split(',').map(Number)
          const remapped = memberIds.map((memberId) => {
            const label = labelOf(previous, memberId)
            return label ? idForLabel(allChannels, label) : undefined
          })
          if (remapped.some((memberId) => memberId === undefined)) return
          next[getOverlayRangeKey(remapped)] = value
          return
        }
        const label = labelOf(previous, id)
        const nextId = label ? idForLabel(allChannels, label) : undefined
        if (nextId !== undefined) next[nextId] = value
      })
      return next
    }

    setChannelStripHeights((prev) => remapIdRecord(prev))
    setChannelYZoom((prev) => remapIdRecord(prev, { allowOverlayKeys: true }))
    setChannelYRange((prev) => remapIdRecord(prev, { allowOverlayKeys: true }))

    setOverlayGroups((prev) => {
      const next = sanitizeOverlayGroups(
        prev.map((group) => group.map((id) => {
          if (nextIds.has(id)) return id
          const label = labelOf(previous, id)
          return label ? idForLabel(allChannels, label) : undefined
        }).filter((id) => id !== undefined))
      )
      return overlayGroupsEqual(prev, next) ? prev : next
    })

    setOverviewChannelId((prev) => {
      if (nextIds.has(prev)) return prev
      const label = labelOf(previous, prev)
      const nextId = label ? idForLabel(allChannels, label) : undefined
      if (nextId !== undefined) return nextId
      return getDefaultOverviewChannelId(allChannels, getDefaultSelection(allChannels))
    })
  }, [allChannels])

  const panelHeightRef = useRef(panelHeight)
  const panelHeightBeforeFillRef = useRef(null)
  const channelLabelWidthRef = useRef(channelLabelWidth)
  const channelStripHeightsRef = useRef(channelStripHeights)
  const channelYZoomRef = useRef(channelYZoom)
  const channelYRangeRef = useRef(channelYRange)
  const activeChannelsRef = useRef(activeChannels)
  const selectedChannelsRef = useRef(selectedChannels)
  const temporaryChannelIdsRef = useRef(temporaryChannelIds)
  const layoutStripHeightsRef = useRef(layoutStripHeights)
  const hoverContextRef = useRef(null)
  const dragStateRef = useRef(null)
  const channelLabelPointerRef = useRef(null)
  const onDragMoveRef = useRef(() => {})
  const endDragRef = useRef(() => {})
  const maskEditDragRef = useRef(null)
  const savedRecordIdRef = useRef(savedRecordId)
  const maskOverridesRef = useRef(maskOverrides)
  const maskHistoryRef = useRef(maskHistory)
  const viewRangeRef = useRef({ viewStart, viewEnd })
  const saveEdfResolversRef = useRef(null)

  useEffect(() => {
    panelHeightRef.current = panelHeight
  }, [panelHeight])

  useEffect(() => {
    channelLabelWidthRef.current = channelLabelWidth
  }, [channelLabelWidth])

  useEffect(() => {
    channelStripHeightsRef.current = channelStripHeights
  }, [channelStripHeights])

  useEffect(() => {
    channelYZoomRef.current = channelYZoom
  }, [channelYZoom])

  useEffect(() => {
    channelYRangeRef.current = channelYRange
  }, [channelYRange])

  useEffect(() => {
    activeChannelsRef.current = activeChannels
  }, [activeChannels])

  useEffect(() => {
    selectedChannelsRef.current = selectedChannels
  }, [selectedChannels])

  useEffect(() => {
    temporaryChannelIdsRef.current = temporaryChannelIds
  }, [temporaryChannelIds])

  useEffect(() => {
    layoutStripHeightsRef.current = layoutStripHeights
  }, [layoutStripHeights])

  useEffect(() => {
    savedRecordIdRef.current = savedRecordId
  }, [savedRecordId])

  useEffect(() => {
    maskOverridesRef.current = maskOverrides
  }, [maskOverrides])

  useEffect(() => {
    maskHistoryRef.current = maskHistory
  }, [maskHistory])

  useEffect(() => {
    viewRangeRef.current = { viewStart, viewEnd }
  }, [viewStart, viewEnd])

  useEffect(() => {
    setSavedRecordId(edfData.savedRecordId ?? null)
    setMaskOverrides({})
    setMaskSelection(null)
    setMaskHistory([])
  }, [edfData.fileName, edfData.savedRecordId])

  useEffect(() => {
    setImportedChannels([])
    setRemovedPersistedChannelIds([])
    setImportError('')
    setSelectedChannels((prev) => {
      if (!prev.some((id) => id >= PARQUET_CHANNEL_ID_BASE)) return prev
      return prev.filter((id) => id < PARQUET_CHANNEL_ID_BASE)
    })
    setChannelFormats((prev) => {
      const hasImported = Object.keys(prev).some((id) => Number(id) >= PARQUET_CHANNEL_ID_BASE)
      if (!hasImported) return prev
      const next = {}
      Object.entries(prev).forEach(([id, format]) => {
        if (Number(id) < PARQUET_CHANNEL_ID_BASE) next[id] = format
      })
      return next
    })
    setBinaryMaskOverlays((prev) => {
      const hasImported = Object.keys(prev).some((id) => Number(id) >= PARQUET_CHANNEL_ID_BASE)
        || Object.values(prev).some((targets) => targets.some((id) => id >= PARQUET_CHANNEL_ID_BASE))
      if (!hasImported) return prev
      const next = {}
      Object.entries(prev).forEach(([id, targets]) => {
        if (Number(id) >= PARQUET_CHANNEL_ID_BASE) return
        next[id] = targets.filter((targetId) => targetId < PARQUET_CHANNEL_ID_BASE)
      })
      return next
    })
  }, [edfData.fileName])

  useEffect(() => {
    if (!edfData.savedRecordId) return undefined

    let cancelled = false

    async function loadMaskEdits() {
      try {
        const edits = await getBinaryMaskEdits(edfData.savedRecordId)
        if (cancelled || edits.length === 0) return

        const overrides = {}
        edits.forEach(({ channelLabel, maskBuffer }) => {
          const channel = edfData.channels.find((ch) => ch.label === channelLabel)
          if (!channel) return
          overrides[channel.id] = maskBufferToArray(maskBuffer, channel.data.length)
        })

        if (Object.keys(overrides).length > 0) {
          setMaskOverrides(overrides)
        }
      } catch (error) {
        console.error('Failed to load binary mask edits:', error)
      }
    }

    loadMaskEdits()

    return () => {
      cancelled = true
    }
  }, [edfData.savedRecordId, edfData.channels])

  useEffect(() => {
    if (!activeChannelKey) return

    const targetPlotHeight = getPlotHeightForPanel(panelHeightRef.current)
    setChannelStripHeights((prev) =>
      distributeChannelStripHeights(activeChannels, prev, targetPlotHeight)
    )
  }, [activeChannelKey, activeChannels])

  const binaryChannelIds = useMemo(
    () => new Set(allChannels.filter((ch) => isBinarySignal(ch.data)).map((ch) => ch.id)),
    [allChannels]
  )

  const getChannelFormat = useCallback(
    (channelId) => channelFormats[channelId] ?? defaultDepictionFormat(channelById[channelId]),
    [channelFormats, channelById]
  )

  const overlayCandidateChannels = useMemo(
    () =>
      activeChannels.filter(
        (channel) => getChannelFormat(channel.id) === DEPICTION_FORMATS.SEQUENCE
      ),
    [activeChannels, getChannelFormat]
  )

  const binaryMaskChannels = useMemo(
    () =>
      activeChannels.filter(
        (channel) => getChannelFormat(channel.id) === DEPICTION_FORMATS.BINARY_MASK
      ),
    [activeChannels, getChannelFormat]
  )

  const drawnBinaryMaskChannels = useMemo(
    () =>
      drawnChannels.filter(
        (channel) => getChannelFormat(channel.id) === DEPICTION_FORMATS.BINARY_MASK
      ),
    [drawnChannels, getChannelFormat]
  )

  const canUndoMaskEdit = maskHistory.length > 0

  const getBinaryMaskOverlayTargets = useCallback(
    (maskChannelId) => {
      if (binaryMaskOverlays[maskChannelId]) {
        return binaryMaskOverlays[maskChannelId]
      }
      if (getChannelFormat(maskChannelId) === DEPICTION_FORMATS.STEM) return []
      return getDefaultBinaryMaskOverlayTargets(maskChannelId, selectedChannels, channelFormats)
    },
    [binaryMaskOverlays, selectedChannels, channelFormats, getChannelFormat]
  )

  const getMaskData = useCallback(
    (channelId) => maskOverrides[channelId] ?? channelById[channelId]?.data ?? [],
    [maskOverrides, channelById]
  )

  const persistMaskToDb = useCallback(async (recordId, channelId, data) => {
    if (!recordId) return

    const label = channelById[channelId]?.label
    if (!label || channelById[channelId]?.isImported) return

    try {
      await saveBinaryMaskEdit(recordId, label, new Float32Array(data).buffer)
    } catch (error) {
      console.error('Failed to save binary mask edit:', error)
    }
  }, [channelById])

  const syncMaskOverridesToDb = useCallback(async (recordId, nextOverrides, prevOverrides) => {
    if (!recordId) return

    const prevIds = new Set(Object.keys(prevOverrides ?? {}))
    const nextIds = new Set(Object.keys(nextOverrides ?? {}))

    const tasks = [
      ...Object.entries(nextOverrides ?? {}).map(([channelId, data]) =>
        persistMaskToDb(recordId, Number(channelId), data)
      ),
      ...[...prevIds]
        .filter((id) => !nextIds.has(id))
        .map((id) => {
          const label = channelById[Number(id)]?.label
          return label ? deleteBinaryMaskEdit(recordId, label) : Promise.resolve()
        }),
    ]

    try {
      await Promise.all(tasks)
    } catch (error) {
      console.error('Failed to sync binary mask edits:', error)
    }
  }, [persistMaskToDb, channelById])

  const updateMaskAndSave = useCallback((channelId, nextData) => {
    if (
      isAnnotationChannelId(channelId)
      || channelByIdRef.current[channelId]?.isAnnotationChannel
      || channelByIdRef.current[channelId]?.isImported
    ) {
      return
    }
    const snapshot = cloneMaskOverrides(maskOverridesRef.current)
    setMaskHistory((history) => [...history, snapshot].slice(-MAX_MASK_UNDO_HISTORY))
    setMaskOverrides((prev) => ({ ...prev, [channelId]: nextData }))
    persistMaskToDb(savedRecordIdRef.current, channelId, nextData)
  }, [persistMaskToDb])

  const undoMaskEdit = useCallback(() => {
    const history = maskHistoryRef.current
    if (history.length === 0) return

    const previous = history[history.length - 1]
    const current = maskOverridesRef.current

    setMaskHistory(history.slice(0, -1))
    setMaskOverrides(previous)
    syncMaskOverridesToDb(savedRecordIdRef.current, previous, current)
  }, [syncMaskOverridesToDb])

  const persistAllMaskOverrides = useCallback(async (recordId) => {
    const overrides = maskOverridesRef.current
    await Promise.all(
      Object.entries(overrides).map(([channelId, data]) =>
        persistMaskToDb(recordId, Number(channelId), data)
      )
    )
  }, [persistMaskToDb])

  const refreshPresets = useCallback(async () => {
    try {
      const presets = await listViewPresets()
      setSavedPresets(presets)
      return presets
    } catch (error) {
      setPresetError(error.message || 'Failed to load saved presets')
      return []
    } finally {
      setPresetsLoading(false)
    }
  }, [])

  const applyPresetToViewer = useCallback((preset, message) => {
    const next = applyViewParams(preset.params, edfData, totalDuration)
    setDraftAnnotationGroups(null)
    setAnnotationGroups(next.annotationGroups)
    setSelectedChannels(next.selectedChannels)
    setChannelFormats(next.channelFormats)
    setBinaryMaskOverlays(next.binaryMaskOverlays)
    setChannelStripHeights(next.channelStripHeights)
    setChannelYZoom(next.channelYZoom)
    setChannelYRange(next.channelYRange)
    setOverviewChannelId(next.overviewChannelId)
    setWindowSeconds(next.windowSeconds)
    setViewStart(next.viewStart)
    setPanelHeight(next.panelHeight)
    setOverlayGroups(next.overlayGroups)
    setTemporaryChannelIds(null)
    setLoadedPresetId(preset.id)
    setActiveTab(next.activeTab)
    setPresetError('')
    if (message) setPresetMessage(message)
  }, [edfData, totalDuration])

  useEffect(() => {
    let cancelled = false

    async function loadInitialPresets() {
      setPresetsLoading(true)
      setPresetError('')
      setPresetMessage('')

      const presets = await refreshPresets()
      if (cancelled) return

      if (presets.length > 0) {
        const newest = presets[0]
        applyPresetToViewer(newest, `Loaded newest view format "${newest.name}"`)
      }
    }

    loadInitialPresets()

    return () => {
      cancelled = true
    }
  }, [edfData, totalDuration, refreshPresets, applyPresetToViewer])

  const getCurrentViewParams = useCallback(
    () =>
      buildViewParams({
        edfData,
        selectedChannels,
        channelFormats,
        binaryMaskOverlays,
        channelStripHeights,
        channelYZoom,
        channelYRange,
        overviewChannelId,
        windowSeconds,
        viewStart,
        panelHeight,
        activeTab,
        annotationGroups,
        allChannels,
        overlayGroups,
      }),
    [
      edfData,
      selectedChannels,
      channelFormats,
      binaryMaskOverlays,
      channelStripHeights,
      channelYZoom,
      channelYRange,
      overviewChannelId,
      windowSeconds,
      viewStart,
      panelHeight,
      activeTab,
      annotationGroups,
      allChannels,
      overlayGroups,
    ]
  )

  const loadedPreset = useMemo(
    () => savedPresets.find((preset) => preset.id === loadedPresetId) ?? null,
    [savedPresets, loadedPresetId]
  )

  const isLoadedPresetModified = useMemo(() => {
    if (!loadedPreset) return false
    return !areViewParamsEqual(getCurrentViewParams(), loadedPreset.params, edfData, totalDuration)
  }, [
    loadedPreset,
    getCurrentViewParams,
    edfData,
    totalDuration,
    selectedChannels,
    channelFormats,
    binaryMaskOverlays,
    channelStripHeights,
    channelYZoom,
    channelYRange,
    overviewChannelId,
    windowSeconds,
    viewStart,
    panelHeight,
    activeTab,
    annotationGroups,
    overlayGroups,
  ])

  const getChannelPlotWidth = useCallback(
    () => Math.max(canvasSize.width - channelLabelWidth - PLOT_PADDING.right, 1),
    [canvasSize.width, channelLabelWidth]
  )

  useEffect(() => {
    if (canvasSize.width <= 0) return
    const maxForPlot = Math.max(
      MIN_CHANNEL_LABEL_WIDTH,
      canvasSize.width - PLOT_PADDING.right - Y_VALUE_REGION_WIDTH - 80
    )
    const maxAllowed = Math.min(MAX_CHANNEL_LABEL_WIDTH, maxForPlot)
    if (channelLabelWidthRef.current <= maxAllowed) return
    channelLabelWidthRef.current = maxAllowed
    setChannelLabelWidth(maxAllowed)
  }, [canvasSize.width])

  const readChannelDisplayRange = useCallback((channelId) => {
    if (isOverlayRangeKey(channelId)) {
      const group = displayStripsRef.current.find(
        (strip) => strip.kind === 'overlay' && strip.key === channelId
      )
      if (!group) return null
      const sequenceMembers = group.channels.filter((member) => {
        const memberFormat = getChannelFormat(member.id)
        return memberFormat !== DEPICTION_FORMATS.BINARY_MASK
          && memberFormat !== DEPICTION_FORMATS.STEM
      })
      const axisMembers = sequenceMembers.length > 0
        ? sequenceMembers
        : group.channels.filter((member) => getChannelFormat(member.id) !== DEPICTION_FORMATS.STEM)
      const plotWidth = getChannelPlotWidth()
      const { viewStart: rangeStart, viewEnd: rangeEnd } = viewRangeRef.current
      let minVal = Infinity
      let maxVal = -Infinity
      axisMembers.forEach((member) => {
        const samples = downsampleRange(
          getMaskData(member.id),
          rangeStart * member.sampleRate,
          rangeEnd * member.sampleRate,
          plotWidth
        )
        samples.forEach(({ min, max }) => {
          if (min < minVal) minVal = min
          if (max > maxVal) maxVal = max
        })
      })
      if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) {
        minVal = 0
        maxVal = 1
      }
      const override = channelYRangeRef.current[channelId]
      if (
        override
        && Number.isFinite(override.min)
        && Number.isFinite(override.max)
        && override.min < override.max
      ) {
        return {
          displayMin: override.min,
          displayMax: override.max,
          displayRange: override.max - override.min,
        }
      }
      const yZoom = channelYZoomRef.current[channelId] ?? DEFAULT_Y_ZOOM
      return getVisibleValueRange(minVal, maxVal, yZoom)
    }

    const channel = channelById[channelId]
    if (!channel) return null

    return getChannelDisplayRange({
      channel,
      viewStart: viewRangeRef.current.viewStart,
      viewEnd: viewRangeRef.current.viewEnd,
      plotWidth: getChannelPlotWidth(),
      channelYZoom: channelYZoomRef.current,
      channelYRange: channelYRangeRef.current,
    })
  }, [channelById, getChannelPlotWidth, getChannelFormat, getMaskData])

  const openYRangeDialog = useCallback((channelId) => {
    if (!isOverlayRangeKey(channelId) && getChannelFormat(channelId) === DEPICTION_FORMATS.BINARY_MASK) return

    const display = readChannelDisplayRange(channelId)
    if (!display) return

    const channel = channelById[channelId]
    const group = displayStripsRef.current.find(
      (strip) => strip.kind === 'overlay' && strip.key === channelId
    )
    setYRangeDialog({
      channelId,
      channelLabel: isOverlayRangeKey(channelId)
        ? (group?.channels.map((member) => member.label).join(', ') || 'Overlay')
        : channel?.label ?? '',
      min: display.displayMin,
      max: display.displayMax,
    })
  }, [channelById, readChannelDisplayRange, getChannelFormat])

  const handleYRangeDialogApply = useCallback((min, max) => {
    if (!yRangeDialog) return

    const { channelId } = yRangeDialog
    setChannelYRange((prev) => ({ ...prev, [channelId]: { min, max } }))
    setChannelYZoom((prev) => {
      if (!prev[channelId]) return prev
      const next = { ...prev }
      delete next[channelId]
      return next
    })
    setYRangeDialog(null)
  }, [yRangeDialog])

  const handleYRangeDialogReset = useCallback(() => {
    if (!yRangeDialog) return

    const { channelId } = yRangeDialog
    setChannelYRange((prev) => {
      const next = { ...prev }
      delete next[channelId]
      return next
    })
    setChannelYZoom((prev) => {
      if (!prev[channelId]) return prev
      const next = { ...prev }
      delete next[channelId]
      return next
    })
    setYRangeDialog(null)
  }, [yRangeDialog])

  const handleChannelYRangeContextMenu = useCallback((event, channelId) => {
    if (!isOverlayRangeKey(channelId) && getChannelFormat(channelId) === DEPICTION_FORMATS.BINARY_MASK) return
    event.preventDefault()
    event.stopPropagation()
    openYRangeDialog(channelId)
  }, [getChannelFormat, openYRangeDialog])

  const handleSavePreset = async () => {
    setPresetError('')
    setPresetMessage('')

    try {
      const committedGroups = commitAnnotationDraft()
      const params = {
        ...getCurrentViewParams(),
        annotationGroups: serializeAnnotationGroups(committedGroups),
      }
      const id = await saveViewPreset(presetName, params)
      await refreshPresets()
      setLoadedPresetId(id)
      setPresetMessage(`Saved view format "${presetName.trim()}"`)
      setPresetName('')
    } catch (error) {
      setPresetError(error.message || 'Failed to save preset')
    }
  }

  const handleLoadPreset = (preset) => {
    applyPresetToViewer(preset, `Loaded view format "${preset.name}"`)
  }

  const handleUpdateLoadedPreset = async () => {
    if (!loadedPreset) return

    setPresetError('')
    setPresetMessage('')

    try {
      const committedGroups = commitAnnotationDraft()
      const params = {
        ...getCurrentViewParams(),
        annotationGroups: serializeAnnotationGroups(committedGroups),
      }
      await updateViewPresetById(loadedPreset.id, params)
      await refreshPresets()
      setPresetMessage(`Updated view format "${loadedPreset.name}"`)
    } catch (error) {
      setPresetError(error.message || 'Failed to update preset')
    }
  }

  const handleDeletePreset = async (preset) => {
    setPresetError('')
    setPresetMessage('')

    try {
      await deleteViewPreset(preset.id)
      if (loadedPresetId === preset.id) {
        setLoadedPresetId(null)
      }
      await refreshPresets()
      setPresetMessage(`Deleted view format "${preset.name}"`)
    } catch (error) {
      setPresetError(error.message || 'Failed to delete preset')
    }
  }

  const buildMergedEdfBuffer = useCallback(() => {
    const getData = (channelId) => getMaskData(channelId)
    const hasMaskEdits = Object.keys(maskOverridesRef.current).length > 0
    const hasImported = importedChannels.length > 0
    const hasRemovedPersisted = removedPersistedChannelIds.length > 0

    if (!hasMaskEdits && !hasImported && !hasRemovedPersisted && edfData.rawBuffer) {
      return edfData.rawBuffer
    }

    return buildEdfBuffer(
      edfData,
      [
        ...visibleFileChannels.map((channel) => channel.id),
        ...importedChannels.map((channel) => channel.id),
      ],
      getData,
      importedChannels
    )
  }, [edfData, getMaskData, importedChannels, removedPersistedChannelIds, visibleFileChannels])

  const performSaveEdf = useCallback(async ({ replaceRecordIds = [], saveAsNew = false } = {}) => {
    setEdfSaveError('')
    setEdfSaveMessage('')

    const mergedBuffer = buildMergedEdfBuffer()
    const summary = buildEdfSummary({
      ...edfData,
      channels: [...visibleFileChannels, ...importedChannels],
    })
    const fileName = edfData.fileName

    for (const recordId of replaceRecordIds) {
      if (recordId !== savedRecordIdRef.current) {
        await deleteEdfRecord(recordId)
      }
    }

    let id = savedRecordIdRef.current
    if (saveAsNew || !id) {
      id = await saveEdfRecord(fileName, mergedBuffer, summary)
    } else {
      await updateEdfRecord(id, fileName, mergedBuffer, summary)
    }

    setSavedRecordId(id)
    savedRecordIdRef.current = id
    await persistAllMaskOverrides(id)
    setEdfSaveMessage(
      saveAsNew
        ? `Saved "${fileName}" as a new IndexedDB copy`
        : `Saved "${fileName}" to IndexedDB`
    )
    return id
  }, [edfData, importedChannels, visibleFileChannels, buildMergedEdfBuffer, persistAllMaskOverrides])

  const resolveSaveEdfPromise = useCallback((error = null) => {
    const resolvers = saveEdfResolversRef.current
    if (!resolvers) return

    if (error) {
      resolvers.reject(error)
    } else {
      resolvers.resolve()
    }

    saveEdfResolversRef.current = null
  }, [])

  const handleSaveEdfConflictCancel = useCallback(() => {
    setSaveConflict(null)
    resolveSaveEdfPromise(new Error('Save cancelled'))
  }, [resolveSaveEdfPromise])

  const handleSaveEdfConflictReplace = useCallback(async () => {
    if (!saveConflict) return

    setIsSavingEdf(true)
    try {
      await performSaveEdf({
        replaceRecordIds: saveConflict.duplicates.map((record) => record.id),
      })
      setSaveConflict(null)
      resolveSaveEdfPromise()
    } catch (error) {
      setEdfSaveError(error.message || 'Failed to save EDF')
      setSaveConflict(null)
      resolveSaveEdfPromise(error)
    } finally {
      setIsSavingEdf(false)
    }
  }, [saveConflict, performSaveEdf, resolveSaveEdfPromise])

  const handleSaveEdfConflictSaveAsNew = useCallback(async () => {
    setIsSavingEdf(true)
    try {
      await performSaveEdf({ saveAsNew: true })
      setSaveConflict(null)
      resolveSaveEdfPromise()
    } catch (error) {
      setEdfSaveError(error.message || 'Failed to save EDF')
      setSaveConflict(null)
      resolveSaveEdfPromise(error)
    } finally {
      setIsSavingEdf(false)
    }
  }, [performSaveEdf, resolveSaveEdfPromise])

  const handleSaveEdf = async () => {
    setEdfSaveError('')
    setEdfSaveMessage('')

    if (
      !edfData.rawBuffer
      && Object.keys(maskOverridesRef.current).length === 0
      && importedChannels.length === 0
      && removedPersistedChannelIds.length === 0
    ) {
      const error = new Error('No raw file data available to save')
      setEdfSaveError(error.message)
      throw error
    }

    const existing = await findEdfRecordsByFileName(edfData.fileName)
    const duplicates = existing.filter((record) => record.id !== savedRecordIdRef.current)

    if (duplicates.length > 0) {
      return new Promise((resolve, reject) => {
        saveEdfResolversRef.current = { resolve, reject }
        setSaveConflict({ duplicates })
      })
    }

    setIsSavingEdf(true)
    try {
      await performSaveEdf()
    } catch (error) {
      setEdfSaveError(error.message || 'Failed to save EDF')
      throw error
    } finally {
      setIsSavingEdf(false)
    }
  }

  const hasPendingExportChanges = useMemo(
    () => Object.keys(maskOverrides).length > 0
      || !savedRecordId
      || importedChannels.length > 0
      || removedPersistedChannelIds.length > 0,
    [maskOverrides, savedRecordId, importedChannels, removedPersistedChannelIds]
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const updateSize = () => {
      const width = container.clientWidth
      if (width > 0) {
        setCanvasSize({ width, height: canvasHeight })
      }
    }

    updateSize()

    const observer = new ResizeObserver(updateSize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [canvasHeight])

  useEffect(() => {
    if (activeTab !== VIEWER_TABS.VIEWER) return

    const container = containerRef.current
    if (!container) return

    const width = container.clientWidth
    if (width > 0) {
      setCanvasSize({ width, height: canvasHeight })
    }
  }, [activeTab, canvasHeight])

  const drawSignals = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const width = canvas.width
    const height = canvas.height
    const padding = { ...PLOT_PADDING, left: channelLabelWidth }
    const plotWidth = Math.max(width - padding.left - padding.right, 1)

    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)

    if (overviewChannel) {
      drawOverviewStrip(ctx, {
        channel: overviewChannel,
        format: getChannelFormat(overviewChannel.id),
        padding,
        plotWidth,
        width,
        yTop: PLOT_PADDING.top,
        stripHeight: OVERVIEW_STRIP_HEIGHT,
        totalDuration,
        viewStart,
        viewEnd,
      })
    }

    if (displayStrips.length === 0) {
      ctx.fillStyle = '#718096'
      ctx.font = '16px Inter, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(
        temporaryChannelIds !== null && drawnChannelIds.length === 0
          ? 'Channels are hidden. Use Show all to bring them back.'
          : 'Select one or more channels to view signals',
        width / 2,
        height / 2
      )
      return
    }

    const binaryMaskSegmentsByChannel = drawnBinaryMaskChannels.map((channel, maskIndex) => ({
      channel,
      maskIndex,
      color: getBinaryMaskColor(maskIndex),
      overlayTargets: getBinaryMaskOverlayTargets(channel.id),
      segments: getBinaryMaskSegments(
        getMaskData(channel.id),
        viewStart * channel.sampleRate,
        viewEnd * channel.sampleRate,
        plotWidth
      ),
    }))

    const annotationOverlayLayers = drawnChannels
      .filter((channel) => getChannelFormat(channel.id) === DEPICTION_FORMATS.STEM)
      .map((channel) => ({
        channel,
        color: CHANNEL_COLORS[channelColorIndex(channel, drawnChannels) % CHANNEL_COLORS.length],
        overlayTargets: getBinaryMaskOverlayTargets(channel.id),
        marks: annotationMarksFor(channel, viewStart, viewEnd, plotWidth),
      }))

    const signalMarkerY = (signal, onset, yTop, yBottom, stripHeight, displayMin, displayRange) => {
      const value = readNearestSample(signal.data, onset, signal.sampleRate)
      if (value === null) return null
      return clampTraceY(
        detailTraceY(value, yBottom, stripHeight, displayMin, displayRange),
        yTop,
        yBottom
      )
    }

    const paintAnnotationMarkerLayer = (
      layer,
      yTop,
      yBottom,
      stripHeight,
      displayMin,
      displayRange,
      signal
    ) => {
      paintAnnotationMarks(ctx, layer.marks, {
        mode: 'marker',
        xLeft: padding.left,
        plotWidth,
        yTop,
        yBottom,
        yForValue: () => yTop,
        yForOnset: signal
          ? (mark) => signalMarkerY(signal, mark.onset, yTop, yBottom, stripHeight, displayMin, displayRange)
          : undefined,
        strokeStyle: layer.color,
        fillStyle: hexToRgba(layer.color, 0.28),
      })
    }

    const drawAnnotationMarkersForTargets = (
      signals,
      yTop,
      yBottom,
      stripHeight,
      displayMin,
      displayRange,
      skipChannelIds
    ) => {
      const targetIds = new Set(signals.map((signal) => signal.id))
      annotationOverlayLayers.forEach((layer) => {
        if (skipChannelIds?.has(layer.channel.id)) return
        signals.forEach((signal) => {
          if (!layer.overlayTargets?.includes(signal.id)) return
          if (!targetIds.has(signal.id)) return
          paintAnnotationMarkerLayer(
            layer,
            yTop,
            yBottom,
            stripHeight,
            displayMin,
            displayRange,
            signal
          )
        })
      })
    }

    let yOffset = getDetailChannelsTop()

    const drawSeriesStroke = (samples, yTop, yBottom, stripHeight, displayMin, displayRange, strokeStyle) => {
      ctx.strokeStyle = strokeStyle
      ctx.lineWidth = 1.5
      ctx.beginPath()
      samples.forEach((point, index) => {
        const x = padding.left + (index / Math.max(samples.length - 1, 1)) * plotWidth
        const yMin = yBottom - 8 - ((point.min - displayMin) / displayRange) * (stripHeight - 16)
        const yMax = yBottom - 8 - ((point.max - displayMin) / displayRange) * (stripHeight - 16)

        if (index === 0) {
          ctx.moveTo(x, yMin)
        } else {
          ctx.lineTo(x, yMin)
        }
        if (Math.abs(yMax - yMin) > 0.5) {
          ctx.lineTo(x, yMax)
        }
      })
      ctx.stroke()
    }

    const drawOverlayStrip = (strip, yTop, yBottom, stripHeight) => {
      const rangeKey = strip.key
      const sequenceMembers = strip.channels.filter((member) => {
        const memberFormat = getChannelFormat(member.id)
        return memberFormat !== DEPICTION_FORMATS.BINARY_MASK
          && memberFormat !== DEPICTION_FORMATS.STEM
      })
      const axisMembers = sequenceMembers.length > 0
        ? sequenceMembers
        : strip.channels.filter((member) => getChannelFormat(member.id) !== DEPICTION_FORMATS.STEM)
      let minVal = Infinity
      let maxVal = -Infinity
      const series = axisMembers.map((member) => {
        const data = getMaskData(member.id)
        const samples = downsampleRange(
          data,
          viewStart * member.sampleRate,
          viewEnd * member.sampleRate,
          plotWidth
        )
        samples.forEach(({ min, max }) => {
          if (min < minVal) minVal = min
          if (max > maxVal) maxVal = max
        })
        return { member, samples }
      })

      const override = channelYRange[rangeKey]
      const hasCustomRange = override
        && Number.isFinite(override.min)
        && Number.isFinite(override.max)
        && override.min < override.max
      const yZoom = channelYZoom[rangeKey] ?? DEFAULT_Y_ZOOM
      let displayMin = 0
      let displayMax = 1
      let displayRange = 1
      if (hasCustomRange) {
        displayMin = override.min
        displayMax = override.max
        displayRange = override.max - override.min
      } else if (Number.isFinite(minVal) && Number.isFinite(maxVal)) {
        const range = getVisibleValueRange(minVal, maxVal, yZoom)
        displayMin = range.displayMin
        displayMax = range.displayMax
        displayRange = range.displayRange
      }

      ctx.strokeStyle = '#edf2f7'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padding.left, (yTop + yBottom) / 2)
      ctx.lineTo(width - padding.right, (yTop + yBottom) / 2)
      ctx.stroke()

      clipToChannelStrip(ctx, padding.left, plotWidth, yTop, stripHeight)

      const overlayMemberIds = new Set(strip.channels.map((member) => member.id))
      const sequenceMemberIds = new Set(sequenceMembers.map((member) => member.id))

      strip.channels.forEach((member) => {
        if (getChannelFormat(member.id) !== DEPICTION_FORMATS.BINARY_MASK) return
        const segments = getBinaryMaskSegments(
          getMaskData(member.id),
          viewStart * member.sampleRate,
          viewEnd * member.sampleRate,
          plotWidth
        )
        const colorIndex = channelColorIndex(member, drawnChannels)
        const color = hexToRgba(CHANNEL_COLORS[colorIndex % CHANNEL_COLORS.length], 0.28)
        drawBinaryMaskSegments(
          ctx,
          segments,
          padding.left,
          plotWidth,
          yTop + 2,
          yBottom - 2,
          color,
          null
        )
      })

      // Keep binary-mask "Overlay on" targets visible after channels are composed.
      binaryMaskSegmentsByChannel.forEach(({ channel: maskChannel, segments, color, overlayTargets }) => {
        if (overlayMemberIds.has(maskChannel.id)) return
        if (!overlayTargets?.some((targetId) => sequenceMemberIds.has(targetId))) return
        drawBinaryMaskSegments(
          ctx,
          segments,
          padding.left,
          plotWidth,
          yTop + 2,
          yBottom - 2,
          color?.fill,
          color?.stroke
        )
      })

      series.forEach(({ member, samples }) => {
        if (samples.length === 0) return
        const colorIndex = channelColorIndex(member, drawnChannels)
        const color = hexToRgba(
          CHANNEL_COLORS[colorIndex % CHANNEL_COLORS.length],
          OVERLAY_LINE_ALPHA
        )
        drawSeriesStroke(samples, yTop, yBottom, stripHeight, displayMin, displayRange, color)
      })

      strip.channels.forEach((member) => {
        if (getChannelFormat(member.id) !== DEPICTION_FORMATS.STEM) return
        const layer = annotationOverlayLayers.find((item) => item.channel.id === member.id)
        if (!layer) return
        if (series.length === 0) {
          paintAnnotationMarkerLayer(layer, yTop, yBottom, stripHeight, displayMin, displayRange, null)
          return
        }
        series.forEach(({ member: signal }) => {
          paintAnnotationMarkerLayer(layer, yTop, yBottom, stripHeight, displayMin, displayRange, {
            id: signal.id,
            data: getMaskData(signal.id),
            sampleRate: signal.sampleRate,
          })
        })
      })
      drawAnnotationMarkersForTargets(
        series.map(({ member }) => ({
          id: member.id,
          data: getMaskData(member.id),
          sampleRate: member.sampleRate,
        })),
        yTop,
        yBottom,
        stripHeight,
        displayMin,
        displayRange,
        overlayMemberIds
      )

      ctx.fillStyle = '#a0aec0'
      ctx.font = '10px Inter, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      const zoomLabel = !hasCustomRange && yZoom !== DEFAULT_Y_ZOOM ? ` · ${yZoom.toFixed(1)}x` : ''
      const customLabel = hasCustomRange ? ' · fixed' : ''
      ctx.fillText(
        `${displayMin.toFixed(1)} – ${displayMax.toFixed(1)}${zoomLabel}${customLabel}`,
        padding.left + 4,
        yTop + 4
      )
      ctx.restore()
    }

    displayStrips.forEach((strip) => {
      const channel = strip.channels[0]
      const stripHeight = getDisplayStripHeight(strip, layoutStripHeights)
      const yTop = yOffset
      const yBottom = yTop + stripHeight
      yOffset = yBottom
      const yMid = (yTop + yBottom) / 2
      const format = getChannelFormat(channel.id)
      const highlighted = strip.kind === 'overlay'
        ? strip.channels.every((member) => manipulationSet.has(member.id))
        : manipulationSet.has(channel.id)

      if (highlighted) {
        ctx.fillStyle = SELECTION_HIGHLIGHT
        ctx.fillRect(0, yTop, width, stripHeight)
      }

      if (strip.kind === 'overlay') {
        drawOverlayStrip(strip, yTop, yBottom, stripHeight)
        return
      }

      ctx.strokeStyle = '#edf2f7'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padding.left, yMid)
      ctx.lineTo(width - padding.right, yMid)
      ctx.stroke()

      const startSample = viewStart * channel.sampleRate
      const endSample = viewEnd * channel.sampleRate

      clipToChannelStrip(ctx, padding.left, plotWidth, yTop, stripHeight)

      binaryMaskSegmentsByChannel.forEach(({ channel: maskChannel, segments, color, overlayTargets }) => {
        if (maskChannel.id === channel.id && format === DEPICTION_FORMATS.BINARY_MASK) {
          return
        }

        if (!overlayTargets?.includes(channel.id)) {
          return
        }

        drawBinaryMaskSegments(
          ctx,
          segments,
          padding.left,
          plotWidth,
          yTop + 2,
          yBottom - 2,
          color?.fill,
          color?.stroke
        )
      })

      if (format === DEPICTION_FORMATS.STEM) {
        const {
          displayMin,
          displayMax,
          displayRange,
          isCustom,
        } = getChannelDisplayRange({
          channel,
          viewStart,
          viewEnd,
          plotWidth,
          channelYZoom,
          channelYRange,
        })
        const color = CHANNEL_COLORS[channelColorIndex(channel, drawnChannels) % CHANNEL_COLORS.length]
        const marks = annotationOverlayLayers.find((item) => item.channel.id === channel.id)?.marks
          ?? annotationMarksFor(channel, viewStart, viewEnd, plotWidth)
        paintAnnotationMarks(ctx, marks, {
          mode: 'stem',
          xLeft: padding.left,
          plotWidth,
          yTop,
          yBottom,
          yForValue: (value) => detailTraceY(value, yBottom, stripHeight, displayMin, displayRange),
          strokeStyle: color,
          fillStyle: hexToRgba(color, 0.28),
        })
        const yZoom = channelYZoom[channel.id] ?? DEFAULT_Y_ZOOM
        ctx.fillStyle = '#a0aec0'
        ctx.font = '10px Inter, sans-serif'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        const zoomLabel = !isCustom && yZoom !== DEFAULT_Y_ZOOM ? ` · ${yZoom.toFixed(1)}x` : ''
        const customLabel = isCustom ? ' · fixed' : ''
        ctx.fillText(
          `${displayMin.toFixed(1)} – ${displayMax.toFixed(1)}${zoomLabel}${customLabel}`,
          padding.left + 4,
          yTop + 4
        )
        ctx.restore()
        return
      }

      if (format === DEPICTION_FORMATS.BINARY_MASK) {
        const maskIndex = drawnBinaryMaskChannels.findIndex((maskChannel) => maskChannel.id === channel.id)
        const color = getBinaryMaskColor(Math.max(maskIndex, 0))
        const maskData = getMaskData(channel.id)
        const ownSegments = getBinaryMaskSegments(maskData, startSample, endSample, plotWidth)
        drawBinaryMaskSegments(
          ctx,
          ownSegments,
          padding.left,
          plotWidth,
          yTop + 2,
          yBottom - 2,
          color.strong,
          color.stroke
        )

        if (
          maskSelection?.channelId === channel.id &&
          maskSelection.startSample !== undefined &&
          maskSelection.endSample !== undefined
        ) {
          const selStartTime = Math.min(maskSelection.startSample, maskSelection.endSample) / channel.sampleRate
          const selEndTime = Math.max(maskSelection.startSample, maskSelection.endSample) / channel.sampleRate
          const x1 = padding.left + ((Math.max(selStartTime, viewStart) - viewStart) / windowSeconds) * plotWidth
          const x2 = padding.left + ((Math.min(selEndTime, viewEnd) - viewStart) / windowSeconds) * plotWidth
          const selWidth = Math.max(x2 - x1, 2)

          ctx.fillStyle = 'rgba(102, 126, 234, 0.25)'
          ctx.fillRect(x1, yTop + 2, selWidth, yBottom - yTop - 4)
          ctx.strokeStyle = '#667eea'
          ctx.lineWidth = 1.5
          ctx.setLineDash([4, 3])
          ctx.strokeRect(x1, yTop + 2, selWidth, yBottom - yTop - 4)
          ctx.setLineDash([])
        }

        ctx.fillStyle = '#a0aec0'
        ctx.font = '10px Inter, sans-serif'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        if (!channel.isImported) {
          ctx.fillText('0 / 1 mask · click event to delete, drag to add', padding.left + 4, yTop + 4)
        }
        ctx.restore()
        return
      }

      const {
        displayMin,
        displayMax,
        displayRange,
        isCustom,
        samples,
      } = getChannelDisplayRange({
        channel,
        viewStart,
        viewEnd,
        plotWidth,
        channelYZoom,
        channelYRange,
      })

      if (samples.length === 0) {
        ctx.restore()
        return
      }

      const yZoom = channelYZoom[channel.id] ?? DEFAULT_Y_ZOOM
      const color = CHANNEL_COLORS[channelColorIndex(channel, drawnChannels) % CHANNEL_COLORS.length]

      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.beginPath()

      samples.forEach((point, index) => {
        const x = padding.left + (index / Math.max(samples.length - 1, 1)) * plotWidth
        const yMin = yBottom - 8 - ((point.min - displayMin) / displayRange) * (stripHeight - 16)
        const yMax = yBottom - 8 - ((point.max - displayMin) / displayRange) * (stripHeight - 16)

        if (index === 0) {
          ctx.moveTo(x, yMin)
        } else {
          ctx.lineTo(x, yMin)
        }
        if (Math.abs(yMax - yMin) > 0.5) {
          ctx.lineTo(x, yMax)
        }
      })

      ctx.stroke()

      drawAnnotationMarkersForTargets(
        [{
          id: channel.id,
          data: channel.data,
          sampleRate: channel.sampleRate,
        }],
        yTop,
        yBottom,
        stripHeight,
        displayMin,
        displayRange
      )

      ctx.fillStyle = '#a0aec0'
      ctx.font = '10px Inter, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      const zoomLabel = !isCustom && yZoom !== DEFAULT_Y_ZOOM ? ` · ${yZoom.toFixed(1)}x` : ''
      const customLabel = isCustom ? ' · fixed' : ''
      ctx.fillText(
        `${displayMin.toFixed(1)} – ${displayMax.toFixed(1)}${zoomLabel}${customLabel}`,
        padding.left + 4,
        yTop + 4
      )
      ctx.restore()
    })

    ctx.fillStyle = '#718096'
    ctx.font = '12px Inter, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(
      `${viewStart.toFixed(0)}s – ${viewEnd.toFixed(0)}s  (${formatDuration(totalDuration)} total)`,
      width / 2,
      height - 20
    )
  }, [edfData, displayStrips, drawnChannels, drawnChannelIds.length, temporaryChannelIds, manipulationSet, channelById, channelFormats, layoutStripHeights, channelYZoom, channelYRange, overviewChannel, drawnBinaryMaskChannels, getChannelFormat, getBinaryMaskOverlayTargets, getMaskData, maskSelection, viewStart, viewEnd, windowSeconds, totalDuration, canvasSize.width, canvasSize.height, channelLabelWidth])

  useEffect(() => {
    if (canvasSize.width > 0) {
      drawSignals()
    }
  }, [drawSignals, canvasSize])

  const selectionIsOverlayGroup = findMatchingOverlayGroupIndex(
    overlayGroups,
    manipulationIds
  ) >= 0

  const applyChannelOverlay = useCallback(() => {
    if (manipulationIds.length < 2) return
    const selected = new Set(manipulationIds)
    setOverlayGroups((prev) => {
      const remaining = prev
        .map((group) => group.filter((id) => !selected.has(id)))
        .filter((group) => group.length >= 2)
      return sanitizeOverlayGroups([...remaining, [...manipulationIds]])
    })
    setManipulationIds([])
  }, [manipulationIds])

  const revertChannelOverlay = useCallback(() => {
    const groupIndex = findMatchingOverlayGroupIndex(overlayGroups, manipulationIds)
    if (groupIndex < 0) return
    setOverlayGroups((prev) => prev.filter((_, index) => index !== groupIndex))
    setManipulationIds([])
  }, [overlayGroups, manipulationIds])

  const toggleManipulation = useCallback((channelIds) => {
    setManipulationIds((prev) => {
      const selected = new Set(prev)
      const allSelected = channelIds.every((id) => selected.has(id))
      if (allSelected) return prev.filter((id) => !channelIds.includes(id))
      const next = [...prev]
      channelIds.forEach((id) => {
        if (!selected.has(id)) next.push(id)
      })
      return next
    })
    setActiveTab(VIEWER_TABS.VIEWER)
  }, [])

  const hideChosenChannels = useCallback(() => {
    if (manipulationIds.length === 0) return
    const hidden = new Set(manipulationIds)
    const base = temporaryChannelIds ?? selectedChannels
    setTemporaryChannelIds(base.filter((id) => channelById[id] && !hidden.has(id)))
    setManipulationIds([])
    setCompareMode(false)
  }, [manipulationIds, temporaryChannelIds, selectedChannels, channelById])

  const showAllChannels = useCallback(() => {
    const seen = new Set()
    const ordered = []
    const base = temporaryChannelIds ?? selectedChannels
    base.forEach((id) => {
      if (!channelById[id] || seen.has(id)) return
      seen.add(id)
      ordered.push(id)
    })
    allChannels.forEach((channel) => {
      if (seen.has(channel.id)) return
      seen.add(channel.id)
      ordered.push(channel.id)
    })
    setTemporaryChannelIds(ordered)
    setCompareMode(false)
  }, [temporaryChannelIds, selectedChannels, channelById, allChannels])

  const showingAllChannels = allChannels.length > 0
    && allChannels.every((channel) => drawnChannelIds.includes(channel.id))

  const handleChannelToggle = (channelId) => {
    setSelectedChannels((prev) =>
      prev.includes(channelId)
        ? prev.filter((id) => id !== channelId)
        : [...prev, channelId]
    )
  }

  const handleImportParquetFiles = async (event) => {
    const fileList = [...(event.target.files ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    event.target.value = ''
    if (fileList.length === 0) return

    setImportError('')
    setIsLoadingParquet(true)
    const errors = []
    const staged = []
    let filesRead = 0

    for (const file of fileList) {
      if (!file.name.toLowerCase().endsWith('.parquet')) {
        errors.push(`"${file.name}" is not a .parquet file`)
        continue
      }

      try {
        const columns = await readParquetNumericColumns(await file.arrayBuffer())
        const sampleRateText = defaultImportSampleRateText(file.name, importSampleRate)
        columns.forEach((column) => {
          pendingImportKeyRef.current += 1
          staged.push({
            key: pendingImportKeyRef.current,
            fileName: file.name,
            columnName: column.name,
            label: importChannelLabel(file.name, column.name, columns.length),
            data: column.data,
            sampleRateText,
            included: true,
          })
        })
        filesRead += 1
      } catch (error) {
        errors.push(error.message || `Failed to read "${file.name}"`)
      }
    }

    if (staged.length > 0) {
      setPendingImportColumns((prev) => [...prev, ...staged])
    }
    if (errors.length > 0) {
      const summary = filesRead > 0
        ? `Loaded ${filesRead} file${filesRead === 1 ? '' : 's'} (${staged.length} column${staged.length === 1 ? '' : 's'}). `
        : ''
      setImportError(`${summary}${errors.join(' ')}`)
    }
    setIsLoadingParquet(false)
  }

  const handlePendingSampleRateChange = (key, value) => {
    setPendingImportColumns((prev) => prev.map((column) => (
      column.key === key ? { ...column, sampleRateText: value } : column
    )))
  }

  const handlePendingIncludedChange = (key, included) => {
    setPendingImportColumns((prev) => prev.map((column) => (
      column.key === key ? { ...column, included } : column
    )))
  }

  const handleApplyDefaultRateToPending = () => {
    const rateText = String(importSampleRate ?? '').trim()
    if (!rateText) {
      setImportError('Enter a sample rate override before applying it to pending columns.')
      return
    }
    try {
      parseSampleRateText(rateText)
    } catch (error) {
      setImportError(error.message || 'Sample rate must be a positive number')
      return
    }
    setImportError('')
    setPendingImportColumns((prev) => prev.map((column) => (
      column.included ? { ...column, sampleRateText: rateText } : column
    )))
  }

  const handleClearPendingImport = () => {
    setPendingImportColumns([])
    setImportError('')
  }

  const handleConfirmPendingImport = () => {
    const selected = pendingImportColumns.filter((column) => column.included)
    if (selected.length === 0) {
      setImportError('Select at least one column to import.')
      return
    }

    const errors = []
    const created = []
    const usedLabels = new Set(allChannels.map((channel) => channel.label))

    selected.forEach((column) => {
      try {
        const sampleRate = parseSampleRateText(column.sampleRateText)
        const label = uniqueChannelLabel(column.label, usedLabels)
        const id = nextImportedIdRef.current
        nextImportedIdRef.current += 1
        created.push(buildImportedChannel({
          id,
          label,
          data: column.data,
          sampleRate,
          sourceFileName: column.fileName,
        }))
      } catch {
        errors.push(`"${column.label}" needs a positive sample rate.`)
      }
    })

    if (errors.length > 0) {
      setImportError(errors.join(' '))
      return
    }

    const binaryIds = created
      .filter((channel) => isBinarySignal(channel.data))
      .map((channel) => channel.id)

    setImportedChannels((prev) => [...prev, ...created])
    setSelectedChannels((prev) => [...prev, ...created.map((channel) => channel.id)])
    if (binaryIds.length > 0) {
      setChannelFormats((prev) => {
        const next = { ...prev }
        binaryIds.forEach((id) => {
          next[id] = DEPICTION_FORMATS.BINARY_MASK
        })
        return next
      })
      setBinaryMaskOverlays((prev) => {
        const next = { ...prev }
        const nextFormats = { ...channelFormats }
        binaryIds.forEach((id) => {
          nextFormats[id] = DEPICTION_FORMATS.BINARY_MASK
        })
        binaryIds.forEach((id) => {
          next[id] = getDefaultBinaryMaskOverlayTargets(id, selectedChannels, nextFormats)
        })
        return next
      })
    }

    setPendingImportColumns([])
    setImportError('')
  }

  const signalChannelCount = visibleFileChannels.length + importedChannels.length

  const handleRemoveChannel = (channelId) => {
    if (signalChannelCount <= 1) return
    setImportedChannels((prev) => prev.filter((channel) => channel.id !== channelId))
    setRemovedPersistedChannelIds((prev) => {
      if (!edfData.channels.some((channel) => channel.id === channelId)) return prev
      return prev.includes(channelId) ? prev : [...prev, channelId]
    })
    setSelectedChannels((prev) => prev.filter((id) => id !== channelId))
    setChannelFormats((prev) => {
      if (!(channelId in prev)) return prev
      const next = { ...prev }
      delete next[channelId]
      return next
    })
    setBinaryMaskOverlays((prev) => {
      const next = {}
      Object.entries(prev).forEach(([id, targets]) => {
        if (Number(id) === channelId) return
        next[id] = targets.filter((targetId) => targetId !== channelId)
      })
      return next
    })
    setMaskOverrides((prev) => {
      if (!(channelId in prev)) return prev
      const next = { ...prev }
      delete next[channelId]
      return next
    })
    setOverviewChannelId((prev) => {
      if (prev !== channelId) return prev
      const remaining = allChannels.filter((channel) => channel.id !== channelId)
      const preferred = selectedChannels.filter((id) => id !== channelId)
      return getDefaultOverviewChannelId(remaining, preferred)
    })
  }

  const handleFormatChange = (channelId, format) => {
    setChannelFormats((prev) => ({
      ...prev,
      [channelId]: format,
    }))

    if (format === DEPICTION_FORMATS.BINARY_MASK) {
      setBinaryMaskOverlays((prev) => {
        if (prev[channelId]?.length) return prev

        const nextFormats = {
          ...channelFormats,
          [channelId]: format,
        }

        return {
          ...prev,
          [channelId]: getDefaultBinaryMaskOverlayTargets(channelId, selectedChannels, nextFormats),
        }
      })
    }
  }

  const handleBinaryMaskOverlayToggle = (maskChannelId, targetChannelId, enabled) => {
    setBinaryMaskOverlays((prev) => {
      const current = prev[maskChannelId] ?? (
        getChannelFormat(maskChannelId) === DEPICTION_FORMATS.STEM
          ? []
          : getDefaultBinaryMaskOverlayTargets(
            maskChannelId,
            selectedChannels,
            channelFormats
          )
      )
      const nextTargets = enabled
        ? [...new Set([...current, targetChannelId])]
        : current.filter((id) => id !== targetChannelId)

      return {
        ...prev,
        [maskChannelId]: nextTargets,
      }
    })
  }

  const cloneAnnotationGroups = useCallback((groups) => (
    (groups ?? []).map((group) => ({
      name: group.name,
      labels: { ...(group.labels ?? {}) },
    }))
  ), [])

  const commitAnnotationGroups = useCallback((nextGroups) => {
    const normalized = normalizeAnnotationGroups(nextGroups, uniqueAnnotationLabels)
    draftAnnotationGroupsRef.current = null
    annotationGroupsRef.current = normalized
    setDraftAnnotationGroups(null)
    setAnnotationGroups(normalized)
    return normalized
  }, [uniqueAnnotationLabels])

  const commitAnnotationDraft = useCallback(() => {
    const draft = draftAnnotationGroupsRef.current
    if (!draft) return annotationGroupsRef.current
    return commitAnnotationGroups(draft)
  }, [commitAnnotationGroups])

  const updateAnnotationDraft = useCallback((updater) => {
    setDraftAnnotationGroups((prev) => {
      const base = prev ?? cloneAnnotationGroups(annotationGroupsRef.current)
      const next = typeof updater === 'function' ? updater(base) : updater
      draftAnnotationGroupsRef.current = next
      return next
    })
  }, [cloneAnnotationGroups])

  const handleAnnotationSectionBlur = useCallback((event) => {
    const next = event.relatedTarget
    if (next && event.currentTarget.contains(next)) return
    commitAnnotationDraft()
  }, [commitAnnotationDraft])

  const handleResetAnnotationGroups = useCallback(() => {
    commitAnnotationGroups(buildDefaultAnnotationGroups(uniqueAnnotationLabels))
  }, [commitAnnotationGroups, uniqueAnnotationLabels])

  const handleAnnotationGroupRename = useCallback((groupIndex, nextName) => {
    updateAnnotationDraft((prev) =>
      prev.map((group, index) =>
        index === groupIndex ? { ...group, name: nextName } : group
      )
    )
  }, [updateAnnotationDraft])

  const handleAnnotationLabelValueChange = useCallback((groupIndex, label, nextValue) => {
    const value = Math.max(1, Math.round(Number(nextValue)) || 1)
    updateAnnotationDraft((prev) =>
      prev.map((group, index) => {
        if (index !== groupIndex) return group
        if (!(label in group.labels)) return group
        return {
          ...group,
          labels: { ...group.labels, [label]: value },
        }
      })
    )
  }, [updateAnnotationDraft])

  const handleToggleAnnotationLabel = useCallback((groupIndex, label, included) => {
    updateAnnotationDraft((prev) =>
      prev.map((group, index) => {
        const labels = { ...group.labels }

        if (index === groupIndex) {
          if (included) {
            if (!(label in labels)) {
              const maxValue = Math.max(0, ...Object.values(labels).map(Number))
              labels[label] = maxValue + 1
            }
          } else {
            delete labels[label]
          }
          return { ...group, labels }
        }

        if (included && label in labels) {
          delete labels[label]
          return { ...group, labels }
        }

        return group
      })
    )
  }, [updateAnnotationDraft])

  const handleAddAnnotationChannel = useCallback(() => {
    const base = draftAnnotationGroupsRef.current ?? annotationGroupsRef.current
    const used = new Set(base.map((group) => group.name))
    let name = 'CHANNEL'
    let suffix = 1
    while (used.has(name)) {
      suffix += 1
      name = `CHANNEL_${suffix}`
    }
    commitAnnotationGroups([...base, { name, labels: {} }])
  }, [commitAnnotationGroups])

  const handleRemoveAnnotationChannel = useCallback((groupIndex) => {
    const base = draftAnnotationGroupsRef.current ?? annotationGroupsRef.current
    if (base.length <= 1) {
      commitAnnotationGroups(buildDefaultAnnotationGroups(uniqueAnnotationLabels))
      return
    }
    commitAnnotationGroups(base.filter((_, index) => index !== groupIndex))
  }, [commitAnnotationGroups, uniqueAnnotationLabels])

  // Commit pending annotation edits when leaving Channel Select.
  useEffect(() => {
    if (activeTab === VIEWER_TABS.CHANNELS) return undefined
    commitAnnotationDraft()
    return undefined
  }, [activeTab, commitAnnotationDraft])
  const renderChannelSelectItem = (channel) => {
    const isBinary = binaryChannelIds.has(channel.id)
    const format = getChannelFormat(channel.id)
    const maskColorIndex = binaryMaskChannels.findIndex(
      (maskChannel) => maskChannel.id === channel.id
    )
    const maskColor = maskColorIndex >= 0 ? getBinaryMaskColor(maskColorIndex) : null
    const overlayTargets = getBinaryMaskOverlayTargets(channel.id)

    return (
      <div key={channel.id} className="channel-item">
        <div className="channel-item-header">
          <label className="channel-item-select">
            <input
              type="checkbox"
              checked={selectedChannels.includes(channel.id)}
              onChange={() => handleChannelToggle(channel.id)}
            />
            <span className="channel-label">{channel.label}</span>
          </label>
          {maskColor ? (
            <span
              className="binary-mask-color-swatch"
              style={{ backgroundColor: maskColor.stroke }}
              title="Binary mask color"
            />
          ) : null}
          <button
            type="button"
            className="btn btn-small btn-secondary channel-item-remove"
            onClick={() => handleRemoveChannel(channel.id)}
            disabled={signalChannelCount <= 1}
            title={
              signalChannelCount <= 1
                ? 'The recording needs at least one signal channel'
                : 'Remove this channel from the recording (Save EDF to keep the change)'
            }
          >
            Remove
          </button>
        </div>
        <span className="channel-meta">
          {channel.sampleRate.toFixed(1)} Hz
          {channel.physicalDimension ? ` · ${channel.physicalDimension}` : ''}
          {channel.isImported ? ' · imported' : ''}
          {isBinary ? ' · binary' : ''}
        </span>
        <select
          className="channel-depiction-select"
          value={format}
          onChange={(e) => handleFormatChange(channel.id, e.target.value)}
          onClick={(e) => e.stopPropagation()}
          title={isBinary ? 'Choose depiction format' : 'Binary mask requires 0/1 signal values'}
        >
          {DEPICTION_OPTIONS.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={
                option.value === DEPICTION_FORMATS.BINARY_MASK && !isBinary
              }
            >
              {option.label}
              {option.value === DEPICTION_FORMATS.BINARY_MASK && !isBinary
                ? ' (0/1 only)'
                : ''}
            </option>
          ))}
        </select>
        {format === DEPICTION_FORMATS.BINARY_MASK ? (
          <div className="binary-mask-overlay-targets">
            <span className="binary-mask-overlay-label">Overlay on:</span>
            {overlayCandidateChannels.length === 0 ? (
              <span className="binary-mask-overlay-empty">
                Select sequence channels to overlay this mask.
              </span>
            ) : (
              overlayCandidateChannels.map((targetChannel) => (
                <label
                  key={targetChannel.id}
                  className="binary-mask-overlay-option"
                >
                  <input
                    type="checkbox"
                    checked={overlayTargets.includes(targetChannel.id)}
                    onChange={(e) =>
                      handleBinaryMaskOverlayToggle(
                        channel.id,
                        targetChannel.id,
                        e.target.checked
                      )
                    }
                  />
                  <span>{targetChannel.label}</span>
                </label>
              ))
            )}
          </div>
        ) : null}
      </div>
    )
  }

  const renderAnnotationChannelItem = (group, groupIndex, channel) => {
    const includedLabels = Object.entries(group.labels ?? {})
    const canSelect = Boolean(channel)
    const format = channel
      ? getChannelFormat(channel.id)
      : DEPICTION_FORMATS.SEQUENCE
    const maskColorIndex = channel
      ? binaryMaskChannels.findIndex((maskChannel) => maskChannel.id === channel.id)
      : -1
    const maskColor = maskColorIndex >= 0 ? getBinaryMaskColor(maskColorIndex) : null
    const overlayTargets = channel ? getBinaryMaskOverlayTargets(channel.id) : []
    const groupCount = displayAnnotationGroups.length

    return (
      <div
        key={`ann-item-${groupIndex}`}
        className={`channel-item channel-item--annotation${
          draftAnnotationGroups ? ' channel-item--annotation-editing' : ''
        }`}
      >
        <div className="channel-item-header">
          {canSelect ? (
            <input
              type="checkbox"
              checked={selectedChannels.includes(channel.id)}
              onChange={() => handleChannelToggle(channel.id)}
              aria-label={`Select ${group.name}`}
            />
          ) : (
            <input type="checkbox" disabled checked={false} aria-label="Select channel" />
          )}
          <label className="annotation-group-name channel-item-channel-label">
            <span className="visually-hidden">channel-label</span>
            <input
              type="text"
              className="channel-label-input"
              value={group.name}
              onChange={(e) => handleAnnotationGroupRename(groupIndex, e.target.value)}
              placeholder="channel-label"
              onClick={(e) => e.stopPropagation()}
            />
          </label>
          {maskColor ? (
            <span
              className="binary-mask-color-swatch"
              style={{ backgroundColor: maskColor.stroke }}
              title="Binary mask color"
            />
          ) : null}
          <button
            type="button"
            className="btn btn-small btn-secondary channel-item-remove"
            onClick={() => handleRemoveAnnotationChannel(groupIndex)}
            disabled={groupCount <= 1}
            title="Remove this channel-label"
          >
            Remove
          </button>
        </div>
        <span className="channel-meta">
          {canSelect
            ? `${(channel.events?.length ?? 0).toLocaleString()} events · annotation`
            : 'annotation · no labels yet'}
          {includedLabels.length > 0
            ? ` · ${includedLabels.map(([label, value]) => `${label}=${value}`).join(', ')}`
            : ''}
          {draftAnnotationGroups ? ' · editing…' : ''}
        </span>
        {canSelect ? (
          <select
            className="channel-depiction-select"
            value={format}
            onChange={(e) => handleFormatChange(channel.id, e.target.value)}
            onClick={(e) => e.stopPropagation()}
            title="Stem plot places a vertical line at each annotation time"
          >
            {ANNOTATION_DEPICTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
        {canSelect && format === DEPICTION_FORMATS.STEM ? (
          <div className="binary-mask-overlay-targets">
            <span className="binary-mask-overlay-label">Overlay on:</span>
            {overlayCandidateChannels.length === 0 ? (
              <span className="binary-mask-overlay-empty">
                Select sequence channels to mark with this annotation.
              </span>
            ) : (
              overlayCandidateChannels.map((targetChannel) => (
                <label
                  key={targetChannel.id}
                  className="binary-mask-overlay-option"
                >
                  <input
                    type="checkbox"
                    checked={overlayTargets.includes(targetChannel.id)}
                    onChange={(e) =>
                      handleBinaryMaskOverlayToggle(
                        channel.id,
                        targetChannel.id,
                        e.target.checked
                      )
                    }
                  />
                  <span>{targetChannel.label}</span>
                </label>
              ))
            )}
          </div>
        ) : null}
        <div className="annotation-group-label-picker">
          <span className="annotation-group-picker-title">Include labels</span>
          {uniqueAnnotationLabels.map((label) => {
            const included = Object.prototype.hasOwnProperty.call(group.labels, label)
            const value = included ? group.labels[label] : 1
            return (
              <label
                key={label}
                className={`annotation-group-pick-row${
                  included ? ' annotation-group-pick-row--active' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={included}
                  onChange={(e) =>
                    handleToggleAnnotationLabel(groupIndex, label, e.target.checked)
                  }
                />
                <span className="annotation-group-pick-label">{label}</span>
                <span className="annotation-group-value">
                  <span>value</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={value}
                    disabled={!included}
                    onChange={(e) =>
                      handleAnnotationLabelValueChange(groupIndex, label, e.target.value)
                    }
                  />
                </span>
              </label>
            )
          })}
        </div>
      </div>
    )
  }

  const onMaskEditMoveRef = useRef(() => {})
  const completeMaskEditDragRef = useRef(() => {})

  const completeMaskEditDrag = useCallback(() => {
    const drag = maskEditDragRef.current
    if (drag) {
      const data = maskOverridesRef.current[drag.channelId] ?? channelById[drag.channelId]?.data
      if (data) {
        const next = fillEventRange(data, drag.startSample, drag.endSample)
        updateMaskAndSave(drag.channelId, next)
      }
    }

    maskEditDragRef.current = null
    setMaskSelection(null)
    document.body.classList.remove('signal-viewer-mask-editing')
    detachDocumentDragListeners(onMaskEditMoveRef.current, completeMaskEditDragRef.current)
  }, [channelById, updateMaskAndSave])

  completeMaskEditDragRef.current = completeMaskEditDrag

  const onMaskEditMove = useCallback((event) => {
    const drag = maskEditDragRef.current
    if (!drag) return

    const canvas = canvasRef.current
    const channel = channelById[drag.channelId]
    if (!canvas || !channel) return

    const { viewStart: vs, viewEnd: ve } = viewRangeRef.current
    const time = clientXToTime(event.clientX, canvas, vs, ve, channelLabelWidthRef.current)
    const sampleIndex = timeToSampleIndex(time, channel.sampleRate, drag.dataLength)

    maskEditDragRef.current = { ...drag, endSample: sampleIndex }
    setMaskSelection({
      channelId: drag.channelId,
      startSample: drag.startSample,
      endSample: sampleIndex,
    })
  }, [channelById])

  onMaskEditMoveRef.current = onMaskEditMove

  const handleBinaryMaskMouseDown = useCallback((event, channelId) => {
    event.preventDefault()
    event.stopPropagation()

    const canvas = canvasRef.current
    const channel = channelById[channelId]
    if (!canvas || !channel || channel.isAnnotationChannel || channel.isImported) return

    const data = maskOverridesRef.current[channelId] ?? channel.data
    const { viewStart: vs, viewEnd: ve } = viewRangeRef.current
    const time = clientXToTime(event.clientX, canvas, vs, ve, channelLabelWidthRef.current)
    const sampleIndex = timeToSampleIndex(time, channel.sampleRate, data.length)

    if (isActiveBinary(data[sampleIndex])) {
      const next = clearEventAt(data, sampleIndex)
      if (next) {
        updateMaskAndSave(channelId, next)
      }
      return
    }

    maskEditDragRef.current = {
      channelId,
      startSample: sampleIndex,
      endSample: sampleIndex,
      dataLength: data.length,
    }
    setMaskSelection({ channelId, startSample: sampleIndex, endSample: sampleIndex })
    document.body.classList.add('signal-viewer-mask-editing')
    attachDocumentDragListeners(onMaskEditMoveRef.current, completeMaskEditDragRef.current)
  }, [channelById, updateMaskAndSave])

  const zoomIn = () => {
    setWindowSeconds((prev) => Math.max(MIN_WINDOW_SECONDS, prev / 2))
  }

  const zoomOut = () => {
    setWindowSeconds((prev) => Math.min(totalDuration, prev * 2))
  }

  const panLeft = () => {
    setViewStart((prev) => Math.max(0, prev - windowSeconds / 2))
  }

  const panRight = () => {
    setViewStart((prev) => Math.min(totalDuration - windowSeconds, prev + windowSeconds / 2))
  }

  const navigateOverviewToClientX = useCallback((clientX) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0) return

    const scaleX = canvas.width / rect.width
    const mouseX = (clientX - rect.left) * scaleX
    const labelWidth = channelLabelWidthRef.current
    const plotWidth = canvas.width - labelWidth - PLOT_PADDING.right
    if (plotWidth <= 0) return

    const fraction = Math.max(0, Math.min(1, (mouseX - labelWidth) / plotWidth))
    const time = fraction * totalDuration
    setViewStart(clampViewStart(time - windowSeconds / 2, windowSeconds, totalDuration))
  }, [totalDuration, windowSeconds])

  const handleOverviewClick = useCallback((event) => {
    navigateOverviewToClientX(event.clientX)
  }, [navigateOverviewToClientX])

  const handleOverviewWheel = useCallback((event) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0) return

    const scaleX = canvas.width / rect.width
    const mouseX = (event.clientX - rect.left) * scaleX
    const labelWidth = channelLabelWidthRef.current
    const plotWidth = canvas.width - labelWidth - PLOT_PADDING.right
    if (plotWidth <= 0) return

    const fraction = Math.max(0, Math.min(1, (mouseX - labelWidth) / plotWidth))
    const timeAtMouse = fraction * totalDuration
    const zoomFactor = WHEEL_ZOOM_BASE ** (-event.deltaY / 100)
    const newWindowSeconds = Math.max(
      MIN_WINDOW_SECONDS,
      Math.min(totalDuration, windowSeconds * zoomFactor)
    )

    if (newWindowSeconds === windowSeconds) return

    const newViewStart = clampViewStart(
      timeAtMouse - fraction * newWindowSeconds,
      newWindowSeconds,
      totalDuration
    )

    setWindowSeconds(newWindowSeconds)
    setViewStart(newViewStart)
  }, [totalDuration, windowSeconds])

  const handleOverviewWheelRef = useRef(handleOverviewWheel)
  handleOverviewWheelRef.current = handleOverviewWheel

  useEffect(() => {
    const overview = overviewStripRef.current
    if (!overview) return undefined

    const handleWheel = (event) => {
      event.preventDefault()
      event.stopPropagation()
      handleOverviewWheelRef.current(event)
    }

    overview.addEventListener('wheel', handleWheel, { passive: false })
    return () => overview.removeEventListener('wheel', handleWheel)
  }, [overviewStripLayout, overviewChannel])

  const handleChannelYZoomWheel = useCallback((event, channelId) => {
    if (!channelById[channelId] && !isOverlayRangeKey(channelId)) return

    const zoomFactor = Y_WHEEL_ZOOM_BASE ** (-event.deltaY / 100)
    const display = readChannelDisplayRange(channelId)
    if (!display) return

    if (channelYRangeRef.current[channelId]) {
      const center = (display.displayMin + display.displayMax) / 2
      const nextHalfRange = display.displayRange / 2 / zoomFactor
      setChannelYRange((prev) => ({
        ...prev,
        [channelId]: {
          min: center - nextHalfRange,
          max: center + nextHalfRange,
        },
      }))
      return
    }

    setChannelYZoom((prev) => {
      const current = prev[channelId] ?? DEFAULT_Y_ZOOM
      const next = Math.max(MIN_Y_ZOOM, Math.min(MAX_Y_ZOOM, current * zoomFactor))
      if (next === current) return prev
      return { ...prev, [channelId]: next }
    })
  }, [channelById, readChannelDisplayRange])

  const handleChannelYZoomWheelRef = useRef(handleChannelYZoomWheel)
  handleChannelYZoomWheelRef.current = handleChannelYZoomWheel

  useEffect(() => {
    const wrap = canvasWrapRef.current
    if (!wrap) return undefined

    const handleWheel = (event) => {
      const region = event.target.closest('.channel-yzoom-region')
      if (!region) return

      const { channelId } = region.dataset
      if (!channelId) return

      event.preventDefault()
      event.stopPropagation()
      handleChannelYZoomWheelRef.current(event, channelId)
    }

    wrap.addEventListener('wheel', handleWheel, { passive: false, capture: true })
    return () => wrap.removeEventListener('wheel', handleWheel, { capture: true })
  }, [activeTab, displayStripLayouts.length])

  const endDrag = useCallback(() => {
    const wasReordering = dragStateRef.current?.type === 'channel-reorder'
    const wasPanningYCenter = dragStateRef.current?.type === 'channel-y-center'
    dragStateRef.current = null
    document.body.classList.remove('signal-viewer-dragging')
    document.body.classList.remove('signal-viewer-reordering')
    document.body.classList.remove('signal-viewer-y-panning')
    document.body.classList.remove('signal-viewer-label-resizing')
    detachDocumentDragListeners(onDragMoveRef.current, endDragRef.current)
    if (wasReordering) {
      setReorderingChannelId(null)
    }
    if (wasPanningYCenter) {
      setPanningYCenterChannelId(null)
    }
  }, [])

  endDragRef.current = endDrag

  const onDragMove = useCallback((event) => {
    const drag = dragStateRef.current
    if (!drag) return

    if (drag.type === 'panel') {
      const delta = event.clientY - drag.startY
      const nextPanelHeight = Math.max(MIN_PANEL_HEIGHT, drag.startHeight + delta)
      const targetPlotHeight = getPlotHeightForPanel(nextPanelHeight)

      setPanelHeight(nextPanelHeight)
      setChannelStripHeights(
        distributeChannelStripHeights(
          activeChannelsRef.current,
          drag.startStripHeights,
          targetPlotHeight
        )
      )
      return
    }

    if (drag.type === 'label-width') {
      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0) return

      const scaleX = canvas.width / rect.width
      const deltaCanvas = (event.clientX - drag.startX) * scaleX
      const maxForPlot = Math.max(
        MIN_CHANNEL_LABEL_WIDTH,
        canvas.width - PLOT_PADDING.right - Y_VALUE_REGION_WIDTH - 80
      )
      const nextWidth = Math.max(
        MIN_CHANNEL_LABEL_WIDTH,
        Math.min(MAX_CHANNEL_LABEL_WIDTH, maxForPlot, drag.startWidth + deltaCanvas)
      )
      if (nextWidth === channelLabelWidthRef.current) return
      channelLabelWidthRef.current = nextWidth
      setChannelLabelWidth(nextWidth)
      return
    }

    if (drag.type === 'channel') {
      const canvas = canvasRef.current
      const channels = activeChannelsRef.current
      if (!canvas) return
      if (!drag.isBottomEdge && channels.length <= drag.channelIndex + 1) return

      const rect = canvas.getBoundingClientRect()
      if (rect.height <= 0) return

      const scaleY = canvas.height / rect.height
      const deltaCanvas = (event.clientY - drag.startY) * scaleY
      if (Math.abs(deltaCanvas) < 0.5) return

      const upperId = drag.resizeChannelId ?? channels[drag.channelIndex]?.id
      if (upperId === undefined) return
      const nextUpperHeight = Math.max(
        MIN_CHANNEL_STRIP_HEIGHT,
        drag.startUpperHeight + deltaCanvas
      )
      const heightDelta = nextUpperHeight - drag.startUpperHeight
      if (heightDelta === 0) return

      const nextPanelHeight = Math.max(
        MIN_PANEL_HEIGHT,
        drag.startPanelHeight + heightDelta
      )

      setChannelStripHeights((prev) => ({
        ...prev,
        [upperId]: nextUpperHeight,
      }))
      setPanelHeight(nextPanelHeight)
      return
    }

    if (drag.type === 'channel-reorder') {
      const canvas = canvasRef.current
      const strips = displayStripsRef.current
      if (!canvas || strips.length < 2) return

      const rect = canvas.getBoundingClientRect()
      if (rect.height <= 0) return
      const scaleY = canvas.height / rect.height
      const canvasY = (event.clientY - rect.top) * scaleY
      let offset = getDetailChannelsTop()
      let targetStripIndex = strips.length - 1
      for (let i = 0; i < strips.length; i += 1) {
        const height = getDisplayStripHeight(strips[i], layoutStripHeightsRef.current)
        if (canvasY < offset + height / 2) {
          targetStripIndex = i
          break
        }
        offset += height
      }

      const targetStrip = strips[targetStripIndex]
      if (!targetStrip) return

      const usingTemporary = temporaryChannelIdsRef.current !== null
      const orderIds = usingTemporary
        ? temporaryChannelIdsRef.current
        : selectedChannelsRef.current
      let next = orderIds

      if (isOverlayRangeKey(drag.channelId)) {
        const fromStripIndex = strips.findIndex((strip) => strip.key === drag.channelId)
        if (fromStripIndex === -1 || targetStrip.kind === 'overlay' || fromStripIndex === targetStripIndex) return

        const memberIds = strips[fromStripIndex].channels.map((member) => member.id)
        const memberSet = new Set(memberIds)
        const rest = orderIds.filter((id) => !memberSet.has(id))
        const targetId = targetStrip.channels[0].id
        const restIndex = rest.indexOf(targetId)
        if (restIndex === -1) return

        const insertAt = targetStripIndex > fromStripIndex ? restIndex + 1 : restIndex
        next = moveChannelBlock(orderIds, memberIds, insertAt)
      } else {
        const targetId = targetStrip.channels[0].id
        const fromIndex = orderIds.indexOf(Number(drag.channelId))
        const toIndex = orderIds.indexOf(targetId)
        if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return
        next = reorderArray(orderIds, fromIndex, toIndex)
      }

      if (next === orderIds || next.join(',') === orderIds.join(',')) return

      const channels = next
        .map((id) => channelByIdRef.current[id])
        .filter(Boolean)

      if (usingTemporary) {
        temporaryChannelIdsRef.current = next
        displayStripsRef.current = buildDisplayStrips(
          channels,
          overlayGroupsRef.current
        )
        setTemporaryChannelIds(next)
        return
      }

      selectedChannelsRef.current = next
      activeChannelsRef.current = channels
      if (isOverlayRangeKey(drag.channelId)) {
        displayStripsRef.current = buildDisplayStrips(
          channels,
          overlayGroupsRef.current
        )
      }
      setSelectedChannels(next)
      return
    }

    if (drag.type === 'channel-y-center') {
      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      if (rect.height <= 0 || drag.stripHeight <= 0) return

      const scaleY = canvas.height / rect.height
      const deltaCanvas = (event.clientY - drag.startY) * scaleY
      const valuePerPixel = drag.displayRange / drag.stripHeight
      const deltaValue = -deltaCanvas * valuePerPixel

      setChannelYRange((prev) => ({
        ...prev,
        [drag.channelId]: {
          min: drag.startMin + deltaValue,
          max: drag.startMax + deltaValue,
        },
      }))
      setChannelYZoom((prev) => {
        if (!prev[drag.channelId]) return prev
        const next = { ...prev }
        delete next[drag.channelId]
        return next
      })
    }
  }, [])

  onDragMoveRef.current = onDragMove

  const applyPanelHeight = useCallback((nextPanelHeight) => {
    const height = Math.max(MIN_PANEL_HEIGHT, nextPanelHeight)
    setPanelHeight(height)
    setChannelStripHeights(
      distributeChannelStripHeights(
        activeChannelsRef.current,
        channelStripHeightsRef.current,
        getPlotHeightForPanel(height)
      )
    )
  }, [])

  const handleFillPanelToWindow = useCallback(() => {
    if (panelFillsWindow) {
      setPanelFillsWindow(false)
      return
    }

    panelHeightBeforeFillRef.current = panelHeightRef.current
    setPanelFillsWindow(true)
  }, [panelFillsWindow])

  useLayoutEffect(() => {
    document.body.classList.toggle('signal-viewer-channels-only', panelFillsWindow)

    if (panelFillsWindow) {
      applyPanelHeight(getWindowFillingPanelHeight(containerRef.current))
    } else if (panelHeightBeforeFillRef.current != null) {
      applyPanelHeight(panelHeightBeforeFillRef.current)
      panelHeightBeforeFillRef.current = null
    }

    return () => document.body.classList.remove('signal-viewer-channels-only')
  }, [panelFillsWindow, applyPanelHeight])

  useEffect(() => {
    if (!panelFillsWindow) return undefined

    const fitToWindow = () => {
      applyPanelHeight(getWindowFillingPanelHeight(containerRef.current))
    }

    window.addEventListener('resize', fitToWindow)
    return () => window.removeEventListener('resize', fitToWindow)
  }, [panelFillsWindow, applyPanelHeight])

  const startPanelResize = useCallback((event) => {
    if (!isPrimaryPointerButton(event)) return
    event.preventDefault()
    panelHeightBeforeFillRef.current = null
    setPanelFillsWindow(false)
    dragStateRef.current = {
      type: 'panel',
      startY: event.clientY,
      startHeight: panelHeightRef.current,
      startStripHeights: { ...channelStripHeightsRef.current },
    }
    document.body.classList.add('signal-viewer-dragging')
    attachDocumentDragListeners(onDragMoveRef.current, endDragRef.current)
  }, [])

  const startLabelWidthResize = useCallback((event) => {
    if (!isPrimaryPointerButton(event)) return
    event.preventDefault()
    event.stopPropagation()

    dragStateRef.current = {
      type: 'label-width',
      startX: event.clientX,
      startWidth: channelLabelWidthRef.current,
    }
    document.body.classList.add('signal-viewer-dragging')
    document.body.classList.add('signal-viewer-label-resizing')
    attachDocumentDragListeners(onDragMoveRef.current, endDragRef.current)
  }, [])

  const beginChannelReorder = useCallback((event, channelId, startY = event.clientY) => {
    event.preventDefault()
    event.stopPropagation()

    if (event.currentTarget?.setPointerCapture) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // The pointer may already be captured by the channel label.
      }
    }

    dragStateRef.current = {
      type: 'channel-reorder',
      channelId,
      startY,
    }
    setReorderingChannelId(channelId)
    document.body.classList.add('signal-viewer-dragging')
    document.body.classList.add('signal-viewer-reordering')
    attachDocumentDragListeners(onDragMoveRef.current, endDragRef.current)
  }, [])

  const startChannelReorder = useCallback((event, channelId) => {
    if (!isPrimaryPointerButton(event)) return
    beginChannelReorder(event, channelId)
  }, [beginChannelReorder])

  const handleChannelLabelPointerDown = useCallback((event, strip) => {
    if (!isPrimaryPointerButton(event)) return

    const channel = strip.channels[0]
    if (!channel) return

    channelLabelPointerRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      channelId: strip.kind === 'overlay' ? strip.key : channel.id,
      moved: false,
    }

    if (event.currentTarget.setPointerCapture) {
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Ignore when the pointer is no longer active.
      }
    }
  }, [])

  const handleChannelLabelPointerMove = useCallback((event) => {
    const pointer = channelLabelPointerRef.current
    if (!pointer || pointer.moved || event.pointerId !== pointer.pointerId) return

    const distance = Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY)
    if (distance < CHANNEL_REORDER_DRAG_THRESHOLD) return

    pointer.moved = true
    if (pointer.channelId == null) return
    beginChannelReorder(event, pointer.channelId, pointer.startY)
  }, [beginChannelReorder])

  const handleChannelLabelPointerUp = useCallback((event) => {
    const pointer = channelLabelPointerRef.current
    if (!pointer || event.pointerId !== pointer.pointerId) return

    if (pointer.moved) {
      window.setTimeout(() => {
        if (channelLabelPointerRef.current === pointer) {
          channelLabelPointerRef.current = null
        }
      }, 0)
      return
    }

    channelLabelPointerRef.current = null
  }, [])

  const handleChannelLabelClick = useCallback((channelIds) => {
    const pointer = channelLabelPointerRef.current
    if (pointer?.moved) {
      channelLabelPointerRef.current = null
      return
    }
    toggleManipulation(channelIds)
  }, [toggleManipulation])

  const startChannelYCenterDrag = useCallback((event, channelId) => {
    if (!isPrimaryPointerButton(event)) return
    event.preventDefault()
    event.stopPropagation()

    if (event.currentTarget.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }

    const display = readChannelDisplayRange(channelId)
    const strip = displayStripsRef.current.find((item) => item.key === String(channelId))
    const stripHeight = strip
      ? getDisplayStripHeight(strip, layoutStripHeightsRef.current)
      : getChannelStripHeight(layoutStripHeightsRef.current, channelId)
    if (!display || stripHeight <= 0) return

    dragStateRef.current = {
      type: 'channel-y-center',
      channelId,
      startY: event.clientY,
      startMin: display.displayMin,
      startMax: display.displayMax,
      displayRange: display.displayRange,
      stripHeight,
    }
    setPanningYCenterChannelId(channelId)
    document.body.classList.add('signal-viewer-dragging')
    document.body.classList.add('signal-viewer-y-panning')
    attachDocumentDragListeners(onDragMoveRef.current, endDragRef.current)
  }, [readChannelDisplayRange])

  const startChannelResize = useCallback((event, stripIndex) => {
    if (!isPrimaryPointerButton(event)) return
    event.preventDefault()
    event.stopPropagation()

    const strips = displayStripsRef.current
    if (strips.length <= stripIndex + 1) return

    const heights = channelStripHeightsRef.current
    const resizeChannelId = strips[stripIndex].resizeChannelId

    panelHeightBeforeFillRef.current = null
    setPanelFillsWindow(false)
    dragStateRef.current = {
      type: 'channel',
      channelIndex: stripIndex,
      resizeChannelId,
      startY: event.clientY,
      startUpperHeight: getChannelStripHeight(heights, resizeChannelId),
      startPanelHeight: panelHeightRef.current,
    }
    document.body.classList.add('signal-viewer-dragging')
    attachDocumentDragListeners(onDragMoveRef.current, endDragRef.current)
  }, [])

  const startLastChannelBottomResize = useCallback((event) => {
    if (!isPrimaryPointerButton(event)) return
    event.preventDefault()
    event.stopPropagation()

    const strips = displayStripsRef.current
    if (strips.length === 0) return

    const resizeChannelId = strips[strips.length - 1].resizeChannelId
    const heights = channelStripHeightsRef.current

    panelHeightBeforeFillRef.current = null
    setPanelFillsWindow(false)
    dragStateRef.current = {
      type: 'channel',
      channelIndex: strips.length - 1,
      resizeChannelId,
      isBottomEdge: true,
      startY: event.clientY,
      startUpperHeight: getChannelStripHeight(heights, resizeChannelId),
      startPanelHeight: panelHeightRef.current,
    }
    document.body.classList.add('signal-viewer-dragging')
    attachDocumentDragListeners(onDragMoveRef.current, endDragRef.current)
  }, [])

  useEffect(() => {
    return () => {
      detachDocumentDragListeners(onDragMoveRef.current, endDragRef.current)
      detachDocumentDragListeners(onMaskEditMoveRef.current, completeMaskEditDragRef.current)
      document.body.classList.remove('signal-viewer-dragging')
      document.body.classList.remove('signal-viewer-reordering')
      document.body.classList.remove('signal-viewer-y-panning')
      document.body.classList.remove('signal-viewer-label-resizing')
      document.body.classList.remove('signal-viewer-mask-editing')
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined

    const handleWheel = (event) => {
      event.preventDefault()

      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0) return

      const scaleX = canvas.width / rect.width
      const scaleY = canvas.height / rect.height
      const mouseX = (event.clientX - rect.left) * scaleX
      const mouseY = (event.clientY - rect.top) * scaleY
      const labelWidth = channelLabelWidthRef.current
      const plotWidth = canvas.width - labelWidth - PLOT_PADDING.right
      if (plotWidth <= 0) return

      const fraction = Math.max(0, Math.min(1, (mouseX - labelWidth) / plotWidth))
      const inOverview = mouseY >= PLOT_PADDING.top && mouseY < getDetailChannelsTop()
      const timeAtMouse = inOverview
        ? fraction * totalDuration
        : viewStart + fraction * windowSeconds
      const zoomFactor = WHEEL_ZOOM_BASE ** (-event.deltaY / 100)
      const newWindowSeconds = Math.max(
        MIN_WINDOW_SECONDS,
        Math.min(totalDuration, windowSeconds * zoomFactor)
      )

      if (newWindowSeconds === windowSeconds) return

      const newViewStart = clampViewStart(
        timeAtMouse - fraction * newWindowSeconds,
        newWindowSeconds,
        totalDuration
      )

      setWindowSeconds(newWindowSeconds)
      setViewStart(newViewStart)
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [viewStart, windowSeconds, totalDuration])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (activeTab !== VIEWER_TABS.VIEWER) return
      if (event.target.closest('input, textarea, select')) return

      const isUndo = (event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey
      if (!isUndo) return
      if (maskHistoryRef.current.length === 0) return

      event.preventDefault()
      undoMaskEdit()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTab, undoMaskEdit])

  hoverContextRef.current = {
    viewStart,
    viewEnd,
    totalDuration,
    displayStrips,
    stripHeights: layoutStripHeights,
    overviewChannel,
    getChannelFormat,
    getMaskData,
    readDisplayRange: readChannelDisplayRange,
    colorChannels: drawnChannels,
    plotLeft: channelLabelWidth,
  }

  return (
    <section className="viewer-section">
      <div className="viewer-header">
        <div>
          <h2>Signal Viewer</h2>
          <p className="viewer-meta">
            {edfData.fileName} · {visibleFileChannels.length} channels
            {annotationChannels.length > 0 ? ` · ${annotationChannels.length} annotation` : ''}
            {importedChannels.length > 0 ? ` · ${importedChannels.length} imported` : ''}
            {' · '}
            {formatDuration(totalDuration)}
            {edfData.isEdfPlus ? ' · EDF+' : ''}
            {(edfData.annotations?.length ?? 0) > 0
              ? ` · ${edfData.annotations.length} events`
              : ''}
          </p>
        </div>
        <div className="controls">
          {edfSaveMessage ? <span className="edf-save-message">{edfSaveMessage}</span> : null}
          {edfSaveError ? <span className="edf-save-error">{edfSaveError}</span> : null}
          <button
            className="btn btn-primary"
            onClick={handleSaveEdf}
            disabled={isSavingEdf || !edfData.rawBuffer}
            type="button"
            title={edfData.rawBuffer ? 'Save EDF with merged mask edits to IndexedDB' : 'Raw file data unavailable'}
          >
            {isSavingEdf ? 'Saving...' : 'Save EDF'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => setIsExportDialogOpen(true)}
            type="button"
          >
            Export Data
          </button>
          <button className="btn btn-secondary" onClick={onBack} type="button">
            ← Back to Upload
          </button>
        </div>
      </div>

      <div className="viewer-content">
        <div className="viewer-tabs" role="tablist" aria-label="Viewer sections">
          {VIEWER_TAB_ITEMS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className={`viewer-tab${activeTab === tab.id ? ' viewer-tab-active' : ''}`}
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              {tab.id === VIEWER_TABS.CHANNELS ? ` (${selectedChannels.length})` : ''}
            </button>
          ))}
        </div>

        <div className="viewer-tab-panels">
          <div
            className="viewer-tab-panel viewer-tab-panel-viewer"
            role="tabpanel"
            hidden={activeTab !== VIEWER_TABS.VIEWER}
          >
            <div className="signal-viewer-layout">
              {manipulationIds.length > 0 || (temporaryChannelIds !== null && drawnChannelIds.length === 0) ? (
              <aside className="manipulation-drawer" aria-label="Channel tools">
                <h3>Channel tools</h3>
                {temporaryChannelIds !== null ? (
                  <p className="manipulation-drawer-hint">
                    Temporary display, separate from the view format.
                  </p>
                ) : null}
                <button
                  type="button"
                  className={`btn ${compareMode ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => {
                    setCompareMode((prev) => !prev)
                    setActiveTab(VIEWER_TABS.VIEWER)
                  }}
                >
                  {compareMode ? 'Leave compare' : 'Compare'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={selectionIsOverlayGroup ? revertChannelOverlay : applyChannelOverlay}
                  disabled={!selectionIsOverlayGroup && manipulationIds.length < 2}
                >
                  {selectionIsOverlayGroup ? 'Revert' : 'Overlay'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={hideChosenChannels}
                  disabled={manipulationIds.length === 0}
                >
                  Hide
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={showAllChannels}
                  disabled={allChannels.length === 0 || showingAllChannels}
                >
                  Show all
                </button>
              </aside>
              ) : null}
              <div className="signal-display">
              <div
                className="signal-canvas-container"
                ref={containerRef}
                style={{ height: panelHeight }}
              >
                <div className="signal-canvas-scroll-area">
                  <div className="signal-canvas-wrap" ref={canvasWrapRef}>
                    <canvas
                      ref={canvasRef}
                      width={canvasSize.width}
                      height={canvasSize.height}
                      className="signal-canvas"
                      title="Scroll on the plot to zoom time. Left strip: drag ⋮⋮ to reorder, scroll to zoom Y-axis, drag ◆ to shift range, right-click to set Y range."
                    />
                    {overviewStripLayout && overviewChannel ? (
                      <>
                        <div
                          className="channel-strip-label overview-strip-label"
                          style={{
                            top: `${overviewStripLayout.topPercent}%`,
                            height: `${overviewStripLayout.heightPercent}%`,
                            width: channelLabelWidth,
                          }}
                        >
                          <span
                            className="channel-strip-label-text"
                            title={`Full sequence · ${overviewChannel.label}`}
                          >
                            Full · {overviewChannel.label}
                          </span>
                        </div>
                        <div
                          ref={overviewStripRef}
                          className="overview-strip-region"
                          style={{
                            top: `${overviewStripLayout.topPercent}%`,
                            height: `${overviewStripLayout.heightPercent}%`,
                            left: channelLabelWidth,
                            right: PLOT_PADDING.right,
                          }}
                          onClick={handleOverviewClick}
                          title={`Full sequence · ${overviewChannel.label}. Click to jump, scroll to zoom time.`}
                          aria-label={`Full sequence navigation for ${overviewChannel.label}`}
                        />
                      </>
                    ) : null}
                    {displayStripLayouts.map(({ strip, topPercent, heightPercent }) => {
                      const channel = strip.channels[0]
                      const isOverlay = strip.kind === 'overlay'
                      const isBinaryMask = !isOverlay && getChannelFormat(channel.id) === DEPICTION_FORMATS.BINARY_MASK
                      const unit = !isOverlay && channel.physicalDimension ? ` ${channel.physicalDimension}` : ''
                      const formatLabel = isBinaryMask ? ' [mask]' : ''
                      const chosen = isOverlay
                        ? strip.channels.every((member) => manipulationSet.has(member.id))
                        : manipulationSet.has(channel.id)
                      const sourceLabel = (member) => (
                        member.isImported ? `${member.label} (imported)` : member.label
                      )
                      const labelText = isOverlay
                        ? strip.channels.map(sourceLabel).join(' · ')
                        : `${sourceLabel(channel)}${unit}${formatLabel}`

                      return (
                        <div
                          key={`label-${strip.key}`}
                          className={`channel-strip-label channel-strip-label-select channel-strip-label-reorder${chosen ? ' channel-strip-label-chosen' : ''}`}
                          style={{
                            top: `${topPercent}%`,
                            height: `${heightPercent}%`,
                            width: channelLabelWidth,
                          }}
                          title={`${labelText} · click to ${chosen ? 'deselect' : 'select'} · drag to reorder`}
                          onPointerDown={(event) => handleChannelLabelPointerDown(event, strip)}
                          onPointerMove={handleChannelLabelPointerMove}
                          onPointerUp={handleChannelLabelPointerUp}
                          onPointerCancel={handleChannelLabelPointerUp}
                          onClick={() => handleChannelLabelClick(strip.channels.map((member) => member.id))}
                          onContextMenu={
                            isBinaryMask
                              ? undefined
                              : (event) => handleChannelYRangeContextMenu(
                                event,
                                isOverlay ? strip.key : channel.id
                              )
                          }
                        >
                          <span className="channel-strip-label-text" title={labelText}>
                            {labelText}
                          </span>
                        </div>
                      )
                    })}
                    <div
                      className="channel-label-resize-handle"
                      style={{ left: channelLabelWidth }}
                      onPointerDown={startLabelWidthResize}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize channel name width"
                      title="Drag to expand or shrink channel name width"
                    />
                    {displayStripLayouts.map(({ strip, topPercent, heightPercent }) => {
                      const channel = strip.channels[0]
                      const isOverlay = strip.kind === 'overlay'
                      const isBinaryMask = !isOverlay && getChannelFormat(channel.id) === DEPICTION_FORMATS.BINARY_MASK
                      const rangeKey = isOverlay ? strip.key : channel.id
                      const yZoom = channelYZoom[rangeKey] ?? DEFAULT_Y_ZOOM
                      const hasCustomRange = Boolean(channelYRange[rangeKey])
                      const isDragging = reorderingChannelId === rangeKey
                      const isPanning = panningYCenterChannelId === rangeKey
                      const labelText = isOverlay
                        ? strip.channels.map((member) => member.label).join(', ')
                        : channel.label
                      const regionTitle = isBinaryMask
                        ? `Drag ⋮⋮ to reorder ${labelText}`
                        : `Drag ⋮⋮ to reorder · scroll to zoom Y-axis${hasCustomRange ? '' : ` (${yZoom.toFixed(1)}x)`} · drag ◆ to shift range · right-click to set range`

                      return (
                        <div
                          key={strip.key}
                          className={`channel-yzoom-region${isDragging ? ' channel-yzoom-region-dragging' : ''}${isPanning ? ' channel-yzoom-region-panning' : ''}`}
                          data-channel-id={rangeKey}
                          style={{
                            top: `${topPercent}%`,
                            height: `${heightPercent}%`,
                            left: channelLabelWidth,
                            width: Y_VALUE_REGION_WIDTH,
                          }}
                          title={regionTitle}
                          aria-label={`Y-axis controls for ${labelText}`}
                          onContextMenu={
                            isBinaryMask
                              ? undefined
                              : (event) => handleChannelYRangeContextMenu(event, rangeKey)
                          }
                        >
                          <div
                            className="channel-yzoom-reorder-handle"
                            title={`Drag to reorder ${labelText}`}
                            aria-label={`Reorder ${labelText}`}
                            onPointerDown={(event) => startChannelReorder(
                              event,
                              rangeKey
                            )}
                          >
                            ⋮⋮
                          </div>
                          {!isBinaryMask ? (
                            <div
                              className="channel-y-center-handle"
                              style={{ top: '50%' }}
                              title="Drag to shift Y-axis value range"
                              aria-label={`Shift Y-axis range for ${labelText}`}
                              onPointerDown={(event) => startChannelYCenterDrag(event, rangeKey)}
                            />
                          ) : null}
                        </div>
                      )
                    })}
                    {displayStripLayouts.map(({ strip, topPercent, heightPercent }) => {
                      if (strip.kind === 'overlay') return null
                      const channel = strip.channels[0]
                      if (getChannelFormat(channel.id) !== DEPICTION_FORMATS.BINARY_MASK) return null
                      if (channel.isAnnotationChannel || channel.isImported) return null

                      return (
                        <div
                          key={`mask-edit-${channel.id}`}
                          className="binary-mask-edit-region"
                          style={{
                            top: `${topPercent}%`,
                            height: `${heightPercent}%`,
                            left: channelLabelWidth + Y_VALUE_REGION_WIDTH,
                            right: PLOT_PADDING.right,
                          }}
                          onMouseDown={(event) => handleBinaryMaskMouseDown(event, channel.id)}
                          title={`${channel.label}: click event to delete, drag empty area to add event`}
                          aria-label={`Edit binary mask for ${channel.label}`}
                        />
                      )
                    })}
                    {displayBoundaries.map(({ stripIndex, percent }) => (
                      <div
                        key={stripIndex}
                        className="channel-resize-handle"
                        style={{ top: `${percent}%`, left: channelLabelWidth }}
                        onPointerDown={(event) => startChannelResize(event, stripIndex)}
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label="Resize channel height"
                      />
                    ))}
                    {displayLastBottomPercent !== null ? (
                      <div
                        key="last-channel-bottom"
                        className="channel-resize-handle channel-resize-handle-bottom"
                        style={{ top: `${displayLastBottomPercent}%`, left: channelLabelWidth }}
                        onPointerDown={startLastChannelBottomResize}
                        role="separator"
                        aria-orientation="horizontal"
                      aria-label="Resize last channel height"
                    />
                    ) : null}
                    <SignalHoverOverlay
                      wrapRef={canvasWrapRef}
                      canvasRef={canvasRef}
                      dragStateRef={dragStateRef}
                      maskEditDragRef={maskEditDragRef}
                      contextRef={hoverContextRef}
                    />
                  </div>
                </div>
                <div
                  className="panel-resize-handle"
                  onPointerDown={startPanelResize}
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize signal viewer panel"
                />
                <button
                  type="button"
                  className={`panel-fill-cursor${panelFillsWindow ? ' panel-fill-cursor-active' : ''}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={handleFillPanelToWindow}
                  title={panelFillsWindow ? 'Show Signal Viewer title' : 'Hide title and show channels only'}
                  aria-pressed={panelFillsWindow}
                  aria-label={panelFillsWindow ? 'Show Signal Viewer title' : 'Hide title and show channels only'}
                >
                  <svg className="panel-fill-cursor-icon" viewBox="0 0 12 18" aria-hidden="true">
                    <path d="M6 0.5 L1.5 5.5 H4.2 V12.5 H1.5 L6 17.5 L10.5 12.5 H7.8 V5.5 H10.5 Z" />
                  </svg>
                </button>
                {compareMode ? (
                  <ComparePopup
                    channels={compareChannels}
                    totalDuration={totalDuration}
                    initialViewStart={viewStart}
                    initialWindowSeconds={windowSeconds}
                    shareScale={compareShareScale}
                    onClose={() => setCompareMode(false)}
                  />
                ) : null}
              </div>

              <div className="time-controls">
                <button className="btn btn-small" onClick={zoomIn} type="button">🔍+</button>
                <button className="btn btn-small" onClick={zoomOut} type="button">🔍-</button>
                <button className="btn btn-small" onClick={panLeft} type="button">←</button>
                <button className="btn btn-small" onClick={panRight} type="button">→</button>
                {drawnBinaryMaskChannels.length > 0 || canUndoMaskEdit ? (
                  <button
                    className="btn btn-small"
                    onClick={undoMaskEdit}
                    disabled={!canUndoMaskEdit}
                    type="button"
                    title="Undo last mask edit (Ctrl+Z)"
                  >
                    ↩ Undo
                  </button>
                ) : null}
                <span className="time-info">
                  Window: {viewStart.toFixed(0)}s – {viewEnd.toFixed(0)}s ({windowSeconds}s)
                </span>
              </div>
            </div>
            </div>
          </div>

          <div
            className="viewer-tab-panel viewer-tab-panel-current-view"
            role="tabpanel"
            hidden={activeTab !== VIEWER_TABS.CURRENT_VIEW}
          >
            <div className="view-presets-panel">
              <div className="view-presets-header">
                <h3>View Formats</h3>
                <p className="view-presets-hint">
                  Save all viewer settings to IndexedDB: full sequence channel, channel order, channels,
                  depiction formats, overlay groups, binary mask overlays, time zoom, panel height, channel strip heights,
                  Y-axis zoom, fixed display value ranges for each channel strip (including overlaid strips), and active tab.
                </p>
              </div>

              {loadedPreset ? (
                <div className="view-preset-current">
                  <div className="view-preset-current-info">
                    <span className="view-preset-current-badge">Loaded</span>
                    <span className="view-preset-current-name">{loadedPreset.name}</span>
                    {isLoadedPresetModified ? (
                      <span className="view-preset-modified-badge">Modified</span>
                    ) : null}
                  </div>
                  <button
                    className="btn btn-primary btn-small"
                    onClick={handleUpdateLoadedPreset}
                    type="button"
                    disabled={!isLoadedPresetModified}
                  >
                    Update Format
                  </button>
                </div>
              ) : (
                <p className="view-presets-empty view-presets-no-loaded">
                  No view format loaded. Load a saved format or save the current settings.
                </p>
              )}

              <div className="view-presets-save">
                <input
                  className="view-preset-name-input"
                  type="text"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="Format name"
                  maxLength={80}
                />
                <button
                  className="btn btn-primary btn-small"
                  onClick={handleSavePreset}
                  type="button"
                  disabled={!presetName.trim()}
                >
                  Save View Format
                </button>
              </div>

              {presetMessage ? <p className="view-preset-message">{presetMessage}</p> : null}
              {presetError ? <p className="view-preset-error">{presetError}</p> : null}

              {presetsLoading ? (
                <p className="view-presets-empty">Loading view formats...</p>
              ) : savedPresets.length === 0 ? (
                <p className="view-presets-empty">No saved view formats yet.</p>
              ) : (
                <ul className="view-presets-list">
                  {savedPresets.map((preset) => {
                    const isLoaded = preset.id === loadedPresetId

                    return (
                      <li
                        key={preset.id}
                        className={`view-preset-item${isLoaded ? ' view-preset-item-active' : ''}`}
                      >
                        <div className="view-preset-info">
                          <span className="view-preset-name">
                            {isLoaded ? <span className="view-preset-loaded-marker">● </span> : null}
                            {preset.name}
                            {isLoaded ? <span className="view-preset-loaded-label"> (loaded)</span> : null}
                          </span>
                          <span className="view-preset-meta">
                            {preset.params.selectedChannelLabels?.length ?? 0} channels
                            {(preset.params.channelDisplayOrderLabels ?? preset.params.selectedChannelLabels)?.length
                              ? ` · ${(preset.params.channelDisplayOrderLabels ?? preset.params.selectedChannelLabels).join(' → ')}`
                              : ''}
                            {' · '}
                            {new Date(preset.updatedAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="view-preset-actions">
                          <button
                            className="btn btn-secondary btn-small"
                            onClick={() => handleLoadPreset(preset)}
                            type="button"
                            disabled={isLoaded && !isLoadedPresetModified}
                          >
                            {isLoaded && !isLoadedPresetModified ? 'Loaded' : 'Load'}
                          </button>
                          {isLoaded ? (
                            <button
                              className="btn btn-primary btn-small"
                              onClick={handleUpdateLoadedPreset}
                              type="button"
                              disabled={!isLoadedPresetModified}
                            >
                              Update
                            </button>
                          ) : null}
                          <button
                            className="btn btn-secondary btn-small"
                            onClick={() => handleDeletePreset(preset)}
                            type="button"
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>

          <div
            className="viewer-tab-panel viewer-tab-panel-channels"
            role="tabpanel"
            hidden={activeTab !== VIEWER_TABS.CHANNELS}
          >
            <div className="channel-controls">
              <div className="channel-controls-header">
                <h3>Channel Selection</h3>
              </div>
              <div className="overview-channel-picker">
                <label className="overview-channel-picker-label" htmlFor="overview-channel-select">
                  Full sequence channel
                </label>
                <select
                  id="overview-channel-select"
                  className="overview-channel-select"
                  value={overviewChannelId ?? ''}
                  onChange={(e) => setOverviewChannelId(Number(e.target.value))}
                >
                  {allChannels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.label}
                      {channel.isAnnotationChannel ? ' (annotation)' : ''}
                      {channel.isImported ? ' (imported)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="channel-section">
                <h4 className="channel-section-title">Physiological channels</h4>
                <div className="channel-list">
                  {physiologicalChannelsForList.length === 0 ? (
                    <p className="channel-section-empty">No physiological channels</p>
                  ) : (
                    physiologicalChannelsForList.map((channel) => renderChannelSelectItem(channel))
                  )}
                </div>
              </div>

              <div className="channel-section">
                <h4 className="channel-section-title">Imported channels</h4>
                <div className="channel-list">
                  {importedChannelsForList.length === 0 ? (
                    <p className="channel-section-empty">
                      No parquet series imported. Use Import Data to add files.
                    </p>
                  ) : (
                    importedChannelsForList.map((channel) => renderChannelSelectItem(channel))
                  )}
                </div>
              </div>

              <div className="channel-section">
                <div className="channel-section-header">
                  <h4 className="channel-section-title">Annotation channels</h4>
                  {uniqueAnnotationLabels.length > 0 ? (
                    <div className="channel-section-actions">
                      <button
                        type="button"
                        className="btn btn-small btn-secondary"
                        onClick={handleAddAnnotationChannel}
                      >
                        Add channel-label
                      </button>
                      <button
                        type="button"
                        className="btn btn-small btn-secondary"
                        onClick={handleResetAnnotationGroups}
                      >
                        Reset to one label / channel
                      </button>
                    </div>
                  ) : null}
                </div>
                {uniqueAnnotationLabels.length === 0 ? (
                  <p className="channel-section-empty">
                    No EDF+ annotations found in this file.
                  </p>
                ) : (
                  <>
                    <p className="annotation-group-editor-hint">
                      Hover a channel to pick labels and values. Edits stay in draft until you
                      leave this section or click Apply (avoids rebuilding on every change).
                      Single-label channels can use Binary mask.
                    </p>
                    <div
                      className="annotation-draft-section"
                      onMouseLeave={commitAnnotationDraft}
                      onBlur={handleAnnotationSectionBlur}
                    >
                      <div className="channel-list channel-list--annotation">
                        {annotationItemsForList.map(({ group, groupIndex, channel }) =>
                          renderAnnotationChannelItem(group, groupIndex, channel)
                        )}
                      </div>
                      {draftAnnotationGroups ? (
                        <div className="annotation-draft-actions">
                          <button
                            type="button"
                            className="btn btn-small btn-primary"
                            onClick={commitAnnotationDraft}
                          >
                            Apply annotation changes
                          </button>
                          <button
                            type="button"
                            className="btn btn-small btn-secondary"
                            onClick={() => {
                              draftAnnotationGroupsRef.current = null
                              setDraftAnnotationGroups(null)
                            }}
                          >
                            Discard
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          <div
            className="viewer-tab-panel viewer-tab-panel-import"
            role="tabpanel"
            hidden={activeTab !== VIEWER_TABS.IMPORT}
          >
            <div className="parquet-import-panel">
              <div className="parquet-import-header">
                <h3>Import Data</h3>
                <p className="parquet-import-hint">
                  Select one or many Parquet files in a single pick (for example
                  channel_a.parquet and channel_b.parquet). Sample 0 shares time zero
                  with the EDF. After choosing files, set a sample rate for each column,
                  then import them together. Filename rates (for example 2hz) and the
                  override below pre-fill those fields.
                </p>
              </div>

              <div className="parquet-import-controls">
                <label className="parquet-import-rate" htmlFor="parquet-sample-rate">
                  Default sample rate (Hz)
                  <input
                    id="parquet-sample-rate"
                    className="parquet-import-rate-input"
                    type="number"
                    min="0"
                    step="any"
                    value={importSampleRate}
                    onChange={(event) => setImportSampleRate(event.target.value)}
                    placeholder="from filename"
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={pendingImportColumns.length === 0 || !String(importSampleRate).trim()}
                  onClick={handleApplyDefaultRateToPending}
                >
                  Apply to selected
                </button>
                <label className="btn btn-primary parquet-import-file">
                  {isLoadingParquet ? 'Reading files…' : 'Choose Parquet files'}
                  <input
                    type="file"
                    accept=".parquet,application/vnd.apache.parquet"
                    multiple
                    disabled={isLoadingParquet}
                    onChange={handleImportParquetFiles}
                  />
                </label>
              </div>

              {importError ? <p className="parquet-import-error">{importError}</p> : null}

              {pendingImportColumns.length > 0 ? (
                <div className="parquet-import-pending">
                  <div className="parquet-import-pending-header">
                    <h4>
                      Pending
                      {' '}
                      {pendingImportColumns.length}
                      {' '}
                      column{pendingImportColumns.length === 1 ? '' : 's'}
                      {' from '}
                      {pendingImportFileCount}
                      {' '}
                      file{pendingImportFileCount === 1 ? '' : 's'}
                    </h4>
                    <div className="parquet-import-pending-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={handleClearPendingImport}
                      >
                        Clear
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-small"
                        onClick={handleConfirmPendingImport}
                      >
                        Import selected
                      </button>
                    </div>
                  </div>
                  <ul className="parquet-import-list">
                    {pendingImportColumns.map((column) => (
                      <li key={column.key} className="parquet-import-item parquet-import-item-pending">
                        <label className="parquet-import-include">
                          <input
                            type="checkbox"
                            checked={column.included}
                            onChange={(event) => handlePendingIncludedChange(column.key, event.target.checked)}
                          />
                          <span className="parquet-import-info">
                            <span className="parquet-import-name">{column.label}</span>
                            <span className="parquet-import-meta">
                              {column.fileName}
                              {' · '}
                              {column.data.length.toLocaleString()} samples
                            </span>
                          </span>
                        </label>
                        <label className="parquet-import-rate parquet-import-rate-inline">
                          Hz
                          <input
                            className="parquet-import-rate-input"
                            type="number"
                            min="0"
                            step="any"
                            disabled={!column.included}
                            value={column.sampleRateText}
                            onChange={(event) => handlePendingSampleRateChange(column.key, event.target.value)}
                            placeholder="required"
                          />
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {importedChannels.length === 0 ? (
                pendingImportColumns.length === 0 ? (
                  <p className="parquet-import-empty">No imported series yet.</p>
                ) : null
              ) : (
                <div className="parquet-import-imported">
                  {pendingImportColumns.length > 0 ? (
                    <h4 className="parquet-import-section-title">Imported</h4>
                  ) : null}
                  <ul className="parquet-import-list">
                    {importedChannels.map((channel) => (
                      <li key={channel.id} className="parquet-import-item">
                        <div className="parquet-import-info">
                          <span className="parquet-import-name">{channel.label}</span>
                          <span className="parquet-import-meta">
                            {channel.sourceFileName}
                            {' · '}
                            {channel.data.length.toLocaleString()} samples
                            {' · '}
                            {channel.sampleRate} Hz
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          onClick={() => handleRemoveChannel(channel.id)}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <ChannelYRangeDialog
        isOpen={Boolean(yRangeDialog)}
        channelLabel={yRangeDialog?.channelLabel ?? ''}
        initialMin={yRangeDialog?.min ?? 0}
        initialMax={yRangeDialog?.max ?? 1}
        onClose={() => setYRangeDialog(null)}
        onApply={handleYRangeDialogApply}
        onReset={handleYRangeDialogReset}
      />

      <ExportDataDialog
        isOpen={isExportDialogOpen}
        onClose={() => setIsExportDialogOpen(false)}
        channels={allChannels}
        edfData={edfData}
        getChannelData={getMaskData}
        hasPendingChanges={hasPendingExportChanges}
        onSaveEdf={handleSaveEdf}
        isSavingEdf={isSavingEdf}
      />

      <SaveEdfConflictDialog
        isOpen={Boolean(saveConflict)}
        fileName={edfData.fileName}
        duplicates={saveConflict?.duplicates ?? []}
        isSaving={isSavingEdf}
        onReplace={handleSaveEdfConflictReplace}
        onSaveAsNew={handleSaveEdfConflictSaveAsNew}
        onCancel={handleSaveEdfConflictCancel}
      />
    </section>
  )
}

export default SignalViewer
