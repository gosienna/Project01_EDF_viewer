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

/**
 * Fill 1 Hz bins that overlap the TAL interval [onset, onset + duration).
 * Instantaneous events (missing/zero duration) mark the single bin that contains onset.
 */
export function fillAnnotationInterval(data, onset, duration, value) {
  const sampleCount = data.length
  if (sampleCount <= 0) return

  const onsetTime = Number(onset)
  if (!Number.isFinite(onsetTime)) return

  const rawDuration = Number(duration)
  const durationSec = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0

  // Half-open TAL interval [onset, onset+duration); duration 0 → one sample at onset.
  let startIdx = Math.floor(onsetTime)
  let endIdx = durationSec > 0
    ? Math.ceil(onsetTime + durationSec)
    : startIdx + 1

  if (startIdx < 0) startIdx = 0
  if (endIdx > sampleCount) endIdx = sampleCount
  if (endIdx <= startIdx) {
    endIdx = Math.min(sampleCount, startIdx + 1)
  }

  for (let t = startIdx; t < endIdx; t += 1) {
    data[t] = value
  }
}

/**
 * Build 1 Hz virtual channels from annotation groups.
 * Each TAL event `+onset§duration‖label‖` fills value from onset through onset+duration.
 * @param {{ onset: number, duration: number, label: string }[]} annotations
 * @param {number} totalDuration
 * @param {AnnotationGroup[]} annotationGroups
 */
export function buildAnnotationChannels(annotations, totalDuration, annotationGroups) {
  const sampleCount = Math.max(0, Math.ceil(totalDuration))
  const groups = (annotationGroups ?? []).filter(
    (group) => group && Object.keys(group.labels ?? {}).length > 0
  )

  return groups.map((group, index) => {
    const labelEntries = Object.entries(group.labels ?? {})
    const maxValue = labelEntries.reduce((max, [, value]) => Math.max(max, value), 1)
    const data = new Array(sampleCount).fill(0)
    const labelToValue = new Map(labelEntries)

    for (const event of annotations ?? []) {
      const value = labelToValue.get(event.label)
      if (value === undefined) continue
      fillAnnotationInterval(data, event.onset, event.duration, value)
    }

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
      samplesPerRecord: 1,
      sampleRate: 1,
      data,
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
