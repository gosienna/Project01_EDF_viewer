export const ANNOTATION_CHANNEL_ID_BASE = 1_000_000

/**
 * @typedef {{ name: string, labels: Record<string, number> }} AnnotationGroup
 */

/**
 * Collect unique annotation labels in first-seen order.
 * @param {{ label: string }[]} annotations
 * @returns {string[]}
 */
export function getUniqueAnnotationLabels(annotations) {
  const seen = new Set()
  const labels = []
  for (const event of annotations ?? []) {
    const label = event?.label
    if (!label || seen.has(label)) continue
    seen.add(label)
    labels.push(label)
  }
  return labels
}

/**
 * Default: one label → one group with value 1.
 * @param {string[]} uniqueLabels
 * @returns {AnnotationGroup[]}
 */
export function buildDefaultAnnotationGroups(uniqueLabels) {
  return uniqueLabels.map((label) => ({
    name: label,
    labels: { [label]: 1 },
  }))
}

/**
 * Normalize user/preset groups against labels present in the file.
 * Unknown labels are dropped; unassigned file labels get solo groups.
 * Empty named groups are kept so the UI can add a channel before assigning labels.
 * @param {AnnotationGroup[] | null | undefined} groups
 * @param {string[]} uniqueLabels
 * @returns {AnnotationGroup[]}
 */
export function normalizeAnnotationGroups(groups, uniqueLabels) {
  const labelSet = new Set(uniqueLabels)
  if (!Array.isArray(groups) || groups.length === 0) {
    return buildDefaultAnnotationGroups(uniqueLabels)
  }

  const assigned = new Set()
  const normalized = []
  const usedNames = new Set()

  for (const group of groups) {
    if (!group || typeof group !== 'object') continue
    let name = String(group.name ?? '').trim()
    if (!name) {
      name = 'CHANNEL'
    }
    if (usedNames.has(name)) {
      let suffix = 2
      while (usedNames.has(`${name}_${suffix}`)) suffix += 1
      name = `${name}_${suffix}`
    }
    usedNames.add(name)

    const rawLabels = group.labels && typeof group.labels === 'object' ? group.labels : {}
    const labels = {}

    const entries = Object.entries(rawLabels)
      .map(([label, value]) => [String(label), Number(value)])
      .filter(([label, value]) => labelSet.has(label) && Number.isFinite(value) && value >= 1)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))

    for (const [label, value] of entries) {
      if (assigned.has(label)) continue
      labels[label] = Math.max(1, Math.round(value))
      assigned.add(label)
    }

    normalized.push({ name, labels })
  }

  for (const label of uniqueLabels) {
    if (assigned.has(label)) continue
    let name = label
    if (usedNames.has(name)) {
      let suffix = 2
      while (usedNames.has(`${name}_${suffix}`)) suffix += 1
      name = `${name}_${suffix}`
    }
    usedNames.add(name)
    normalized.push({ name, labels: { [label]: 1 } })
  }

  return normalized.length > 0 ? normalized : buildDefaultAnnotationGroups(uniqueLabels)
}

export function isSingleLabelAnnotationGroup(group) {
  if (!group?.labels) return false
  const keys = Object.keys(group.labels)
  return keys.length === 1
}

function lowerBoundOnset(events, time) {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (events[mid].onset < time) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Marks that overlap [viewStart, viewEnd).
 * Duration 0 is a stem at onset. A positive duration is the half-open span
 * [onset, onset + duration). Stems in one pixel column collapse to the highest
 * value; spans that cover the same pixel range do the same.
 * @param {{ onset: number, duration: number, value: number }[]} events
 */
export function collectVisibleAnnotationMarks(
  events,
  viewStart,
  viewEnd,
  plotWidth,
  maxEventDuration = 0
) {
  if (!events?.length || !(viewEnd > viewStart) || !(plotWidth > 0)) return []

  const span = viewEnd - viewStart
  const width = Math.max(1, Math.floor(plotWidth))
  const searchStart = viewStart - (maxEventDuration > 0 ? maxEventDuration : 0)
  const startIndex = lowerBoundOnset(events, searchStart)
  const endIndex = lowerBoundOnset(events, viewEnd)
  const stems = new Map()
  const spans = new Map()

  for (let index = startIndex; index < endIndex; index += 1) {
    const event = events[index]
    const duration = event.duration > 0 ? event.duration : 0

    if (duration > 0) {
      const end = event.onset + duration
      if (end <= viewStart || event.onset >= viewEnd) continue
      const startFraction = (Math.max(event.onset, viewStart) - viewStart) / span
      const endFraction = (Math.min(end, viewEnd) - viewStart) / span
      const columnStart = Math.max(0, Math.min(width - 1, Math.floor(startFraction * width)))
      const columnEnd = Math.max(columnStart + 1, Math.min(width, Math.ceil(endFraction * width)))
      const key = columnStart * (width + 1) + columnEnd
      const existing = spans.get(key)
      if (!existing || event.value > existing.value) {
        spans.set(key, {
          kind: 'span',
          startFraction: columnStart / width,
          endFraction: columnEnd / width,
          value: event.value,
          onset: event.onset,
          duration,
        })
      }
      continue
    }

    if (event.onset < viewStart || event.onset >= viewEnd) continue
    const fraction = (event.onset - viewStart) / span
    const column = Math.max(0, Math.min(width - 1, Math.floor(fraction * width)))
    const existing = stems.get(column)
    if (!existing || event.value > existing.value) {
      stems.set(column, {
        kind: 'stem',
        fraction,
        value: event.value,
        onset: event.onset,
        duration: 0,
      })
    }
  }

  const marks = [...spans.values(), ...stems.values()]
  marks.sort((a, b) => (a.fraction ?? a.startFraction) - (b.fraction ?? b.startFraction))
  return marks
}

/**
 * Event whose interval contains `time`, otherwise the event with the nearest onset.
 * @param {{ onset: number, duration: number, value: number }[]} events
 */
export function nearestAnnotationEvent(events, time, maxEventDuration = 0) {
  if (!events?.length || !Number.isFinite(time)) return null

  const index = lowerBoundOnset(events, time)
  let best = null
  let bestDist = Infinity

  const consider = (event) => {
    if (!event) return
    const duration = event.duration > 0 ? event.duration : 0
    let dist
    if (duration > 0) {
      const end = event.onset + duration
      if (time >= event.onset && time < end) dist = 0
      else dist = Math.min(Math.abs(time - event.onset), Math.abs(time - end))
    } else {
      dist = Math.abs(event.onset - time)
    }
    if (
      dist < bestDist
      || (dist === bestDist && best && event.onset < best.onset)
    ) {
      bestDist = dist
      best = event
    }
  }

  consider(events[index])
  consider(events[index - 1])
  if (maxEventDuration > 0) {
    const limit = time - maxEventDuration
    for (let cursor = index - 2; cursor >= 0 && events[cursor].onset >= limit; cursor -= 1) {
      consider(events[cursor])
    }
  }

  return best
}

/**
 * Draw collapsed annotation marks.
 * `mode: 'stem'` draws a baseline-to-value stem (and a value-height span).
 * `mode: 'marker'` draws a dot on the target signal when `yForOnset` is set,
 * otherwise a short tick, plus a full-strip span for positive durations.
 */
export function paintAnnotationMarks(ctx, marks, {
  xLeft,
  plotWidth,
  yTop,
  yBottom,
  yForValue,
  yForOnset,
  strokeStyle,
  fillStyle,
  mode,
}) {
  if (!marks?.length) return

  ctx.save()
  if (mode === 'marker') {
    ctx.fillStyle = fillStyle
    marks.forEach((mark) => {
      if (mark.kind !== 'span') return
      const x = xLeft + mark.startFraction * plotWidth
      const width = Math.max((mark.endFraction - mark.startFraction) * plotWidth, 1)
      ctx.fillRect(x, yTop + 2, width, Math.max(yBottom - yTop - 4, 1))
    })

    marks.forEach((mark) => {
      if (mark.kind !== 'stem') return
      const x = xLeft + mark.fraction * plotWidth
      const y = yForOnset?.(mark)
      if (Number.isFinite(y)) {
        ctx.beginPath()
        ctx.fillStyle = strokeStyle
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.25
        ctx.arc(x, y, 3.25, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        return
      }
      if (yForOnset) return
      ctx.strokeStyle = strokeStyle
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, yTop + 3)
      ctx.lineTo(x, yTop + 16)
      ctx.stroke()
    })
    ctx.restore()
    return
  }

  ctx.fillStyle = fillStyle
  marks.forEach((mark) => {
    if (mark.kind !== 'span') return
    const x = xLeft + mark.startFraction * plotWidth
    const width = Math.max((mark.endFraction - mark.startFraction) * plotWidth, 1)
    const yValue = yForValue(mark.value)
    const yZero = yForValue(0)
    const top = Math.min(yValue, yZero)
    ctx.fillRect(x, top, width, Math.max(Math.abs(yZero - yValue), 1))
  })

  ctx.strokeStyle = strokeStyle
  ctx.lineWidth = 1.25
  ctx.beginPath()
  marks.forEach((mark) => {
    if (mark.kind !== 'stem') return
    const x = xLeft + mark.fraction * plotWidth
    const yValue = yForValue(mark.value)
    const yZero = yForValue(0)
    ctx.moveTo(x, yZero)
    ctx.lineTo(x, yValue)
    ctx.moveTo(x - 3, yValue)
    ctx.lineTo(x + 3, yValue)
  })
  ctx.stroke()
  ctx.restore()
}

/**
 * Build virtual channels from annotation groups.
 * Events keep their TAL onset and duration so marks are not quantized to 1 s.
 * @param {{ onset: number, duration: number, label: string }[]} annotations
 * @param {number} _totalDuration
 * @param {AnnotationGroup[]} annotationGroups
 */
export function buildAnnotationChannels(annotations, _totalDuration, annotationGroups) {
  const groups = (annotationGroups ?? []).filter(
    (group) => group && Object.keys(group.labels ?? {}).length > 0
  )

  return groups.map((group, index) => {
    const labelEntries = Object.entries(group.labels ?? {})
    const maxValue = labelEntries.reduce((max, [, value]) => Math.max(max, value), 1)
    const labelToValue = new Map(labelEntries)
    const events = []
    let maxEventDuration = 0

    for (const event of annotations ?? []) {
      const value = labelToValue.get(event.label)
      if (value === undefined) continue
      const onset = Number(event.onset)
      if (!Number.isFinite(onset)) continue
      const rawDuration = Number(event.duration)
      const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0
      if (duration > maxEventDuration) maxEventDuration = duration
      events.push({ onset, duration, value })
    }

    events.sort((a, b) => a.onset - b.onset || a.duration - b.duration || a.value - b.value)

    const singleLabel = isSingleLabelAnnotationGroup(group)

    return {
      id: ANNOTATION_CHANNEL_ID_BASE + index,
      label: group.name,
      transducer: 'EDF+ annotation group',
      physicalDimension: '',
      physicalMin: 0,
      physicalMax: maxValue,
      digitalMin: 0,
      digitalMax: maxValue,
      prefiltering: '',
      samplesPerRecord: 0,
      sampleRate: null,
      data: [],
      events,
      maxEventDuration,
      isAnnotationChannel: true,
      isSingleLabelAnnotation: singleLabel,
      annotationGroup: group,
    }
  })
}

/**
 * Stable serialization for view-format compare.
 * @param {AnnotationGroup[]} groups
 */
export function serializeAnnotationGroups(groups) {
  return (groups ?? []).map((group) => ({
    name: group.name,
    labels: { ...group.labels },
  }))
}
