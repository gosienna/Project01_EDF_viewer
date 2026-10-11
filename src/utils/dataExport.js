import { buildEdfBuffer } from './edfWriter'

export const EXPORT_FORMATS = {
  EDF: 'edf',
  JSON: 'json',
  CSV: 'csv',
}

export function getExportBaseName(fileName) {
  const base = fileName.replace(/\.[^/.]+$/, '')
  return base || 'export'
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function buildChannelMap(edfData, extraChannels = []) {
  return Object.fromEntries(
    [...edfData.channels, ...extraChannels].map((ch) => [ch.id, ch])
  )
}

function buildChannelExportPayload(channel, data) {
  if (channel.isAnnotationChannel) {
    return {
      label: channel.label,
      isAnnotationChannel: true,
      events: (channel.events ?? []).map((event) => ({
        time: event.onset,
        duration: event.duration,
        value: event.value,
      })),
    }
  }

  return {
    label: channel.label,
    sampleRate: channel.sampleRate,
    samplesPerRecord: channel.samplesPerRecord,
    physicalDimension: channel.physicalDimension,
    physicalMin: channel.physicalMin,
    physicalMax: channel.physicalMax,
    digitalMin: channel.digitalMin,
    digitalMax: channel.digitalMax,
    transducer: channel.transducer,
    prefiltering: channel.prefiltering,
    isAnnotationChannel: false,
    isImported: Boolean(channel.isImported),
    data,
  }
}

function buildJsonExport(edfData, channelIds, getChannelData, channelById) {
  const channels = channelIds
    .map((id) => {
      const channel = channelById[id]
      if (!channel) return null
      return buildChannelExportPayload(channel, getChannelData(id))
    })
    .filter(Boolean)

  return {
    fileName: edfData.fileName,
    header: {
      patient: edfData.header.patient,
      recording: edfData.header.recording,
      startDate: edfData.header.startDate,
      startTime: edfData.header.startTime,
      duration: edfData.header.duration,
      numRecords: edfData.header.numRecords,
      totalDuration: edfData.totalDuration,
      isEdfPlus: edfData.isEdfPlus,
    },
    annotations: edfData.annotations ?? [],
    channels,
  }
}

function escapeCsvValue(value) {
  const text = String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function buildCsvExport(edfData, channelIds, getChannelData, channelById) {
  const includeEvents = channelIds.some((id) => channelById[id]?.isAnnotationChannel)
  const lines = [
    includeEvents
      ? 'channel,sample_index,time_seconds,duration,value'
      : 'channel,sample_index,time_seconds,value',
  ]

  channelIds.forEach((id) => {
    const channel = channelById[id]
    if (!channel) return

    if (channel.isAnnotationChannel) {
      ;(channel.events ?? []).forEach((event) => {
        const row = [
          escapeCsvValue(channel.label),
          '',
          Number(event.onset).toFixed(6),
          Number(event.duration) > 0 ? Number(event.duration).toFixed(6) : '0',
          event.value,
        ]
        lines.push(row.join(','))
      })
      return
    }

    const data = getChannelData(id)
    const sampleRate = channel.sampleRate

    for (let i = 0; i < data.length; i += 1) {
      const timeSeconds = sampleRate > 0 ? i / sampleRate : i
      const row = [
        escapeCsvValue(channel.label),
        i,
        timeSeconds.toFixed(6),
        data[i],
      ]
      if (includeEvents) row.splice(3, 0, '')
      lines.push(row.join(','))
    }
  })

  return lines.join('\n')
}

export function exportEdfData({
  format,
  edfData,
  channelIds,
  getChannelData,
  fileName,
  extraChannels = [],
}) {
  const baseName = getExportBaseName(fileName ?? edfData.fileName)
  const channelById = buildChannelMap(edfData, extraChannels)

  if (format === EXPORT_FORMATS.EDF) {
    const physiologicalIds = channelIds.filter((id) => {
      const channel = channelById[id]
      return channel && !channel.isAnnotationChannel
    })
    if (physiologicalIds.length === 0) {
      throw new Error('EDF export requires at least one physiological channel')
    }
    const buffer = buildEdfBuffer(edfData, physiologicalIds, getChannelData, extraChannels)
    downloadBlob(new Blob([buffer], { type: 'application/octet-stream' }), `${baseName}.edf`)
    return
  }

  if (format === EXPORT_FORMATS.JSON) {
    const payload = buildJsonExport(edfData, channelIds, getChannelData, channelById)
    const json = JSON.stringify(payload, null, 2)
    downloadBlob(new Blob([json], { type: 'application/json' }), `${baseName}.json`)
    return
  }

  if (format === EXPORT_FORMATS.CSV) {
    const csv = buildCsvExport(edfData, channelIds, getChannelData, channelById)
    downloadBlob(new Blob([csv], { type: 'text/csv' }), `${baseName}.csv`)
    return
  }

  throw new Error(`Unsupported export format: ${format}`)
}
