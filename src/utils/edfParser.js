function readAscii(bytes, start, length) {
  return new TextDecoder('ascii').decode(bytes.slice(start, start + length)).trim()
}

function readInt(bytes, start, length) {
  return parseInt(readAscii(bytes, start, length), 10) || 0
}

function readFloat(bytes, start, length) {
  return parseFloat(readAscii(bytes, start, length)) || 0
}

function digitalToPhysical(digital, channel) {
  const digRange = channel.digitalMax - channel.digitalMin
  const physRange = channel.physicalMax - channel.physicalMin
  if (digRange === 0) return channel.physicalMin
  return ((digital - channel.digitalMin) / digRange) * physRange + channel.physicalMin
}

const TAL_SEP = 0x14
const TAL_DURATION_CHAR = String.fromCharCode(0x15)
const latin1Decoder = new TextDecoder('latin1')

export function isAnnotationSignalLabel(label) {
  const normalized = String(label ?? '').trim()
  return normalized === 'EDF Annotations' || normalized === 'BDF Annotations'
}

function isEdfPlusReserved(reserved) {
  const value = String(reserved ?? '').trim()
  return value.startsWith('EDF+') || value.startsWith('BDF+')
}

function decodeLatin1(blob, start, end) {
  return latin1Decoder.decode(blob.subarray(start, end))
}

/**
 * Parse Time-stamped Annotation Lists (TAL) from an annotation-channel byte slot.
 * @returns {{ onset: number, duration: number, label: string }[]}
 */
export function parseTalBytes(blob) {
  const events = []
  let i = 0

  while (i < blob.length) {
    while (i < blob.length && blob[i] === 0) i += 1
    if (i >= blob.length) break

    if (blob[i] !== 0x2b && blob[i] !== 0x2d) {
      i += 1
      continue
    }

    const onsetStart = i
    i += 1
    while (i < blob.length && blob[i] !== TAL_SEP && blob[i] !== 0) {
      i += 1
    }

    const onsetField = decodeLatin1(blob, onsetStart, i)
    let onset = 0
    let duration = 0
    const durationIdx = onsetField.indexOf(TAL_DURATION_CHAR)
    if (durationIdx >= 0) {
      onset = parseFloat(onsetField.slice(0, durationIdx)) || 0
      duration = parseFloat(onsetField.slice(durationIdx + 1)) || 0
    } else {
      onset = parseFloat(onsetField) || 0
    }

    const labels = []
    while (i < blob.length && blob[i] === TAL_SEP) {
      i += 1
      const textStart = i
      while (i < blob.length && blob[i] !== TAL_SEP && blob[i] !== 0) {
        i += 1
      }
      const text = decodeLatin1(blob, textStart, i)
      if (text === '') break
      labels.push(text)
    }

    for (const label of labels) {
      events.push({ onset, duration, label })
    }
  }

  return events
}

export async function parseEdfFile(source) {
  const buffer = source instanceof ArrayBuffer
    ? source
    : await source.arrayBuffer()

  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)

  const header = {
    version: readAscii(bytes, 0, 8),
    patient: readAscii(bytes, 8, 80),
    recording: readAscii(bytes, 88, 80),
    startDate: readAscii(bytes, 168, 8),
    startTime: readAscii(bytes, 176, 8),
    headerBytes: readInt(bytes, 184, 8),
    reserved: readAscii(bytes, 192, 44),
    numRecords: readInt(bytes, 236, 8),
    duration: readFloat(bytes, 244, 8),
    numSignals: readInt(bytes, 252, 4),
  }

  const numSignals = header.numSignals
  const base = 256

  const readFieldBlock = (fieldOffset, fieldLength) =>
    Array.from({ length: numSignals }, (_, i) =>
      readAscii(bytes, base + numSignals * fieldOffset + i * fieldLength, fieldLength)
    )

  const labels = readFieldBlock(0, 16)
  const transducers = readFieldBlock(16, 80)
  const physicalDimensions = readFieldBlock(96, 8)
  const physicalMins = readFieldBlock(104, 8).map(Number)
  const physicalMaxs = readFieldBlock(112, 8).map(Number)
  const digitalMins = readFieldBlock(120, 8).map((v) => parseInt(v, 10) || 0)
  const digitalMaxs = readFieldBlock(128, 8).map((v) => parseInt(v, 10) || 0)
  const prefilterings = readFieldBlock(136, 80)
  const samplesPerRecord = readFieldBlock(216, 8).map((v) => parseInt(v, 10) || 0)

  const allSignals = labels.map((label, index) => ({
    id: index,
    label,
    transducer: transducers[index],
    physicalDimension: physicalDimensions[index],
    physicalMin: physicalMins[index],
    physicalMax: physicalMaxs[index],
    digitalMin: digitalMins[index],
    digitalMax: digitalMaxs[index],
    prefiltering: prefilterings[index],
    samplesPerRecord: samplesPerRecord[index],
    sampleRate: header.duration > 0 ? samplesPerRecord[index] / header.duration : 0,
    isAnnotationSignal: isAnnotationSignalLabel(label),
    data: [],
  }))

  const expectedDataBytes = allSignals.reduce(
    (sum, channel) => sum + header.numRecords * channel.samplesPerRecord * 2,
    0
  )
  const expectedFileBytes = header.headerBytes + expectedDataBytes
  if (expectedFileBytes > buffer.byteLength) {
    throw new Error(
      `Invalid EDF file: header expects ${expectedFileBytes} bytes but only ${buffer.byteLength} bytes are available`
    )
  }

  const annotations = []
  let offset = header.headerBytes

  for (let record = 0; record < header.numRecords; record += 1) {
    for (let channelIndex = 0; channelIndex < numSignals; channelIndex += 1) {
      const signal = allSignals[channelIndex]
      const byteLength = signal.samplesPerRecord * 2

      if (signal.isAnnotationSignal) {
        const blob = bytes.subarray(offset, offset + byteLength)
        annotations.push(...parseTalBytes(blob))
        offset += byteLength
      } else {
        for (let sample = 0; sample < signal.samplesPerRecord; sample += 1) {
          const digital = view.getInt16(offset, true)
          offset += 2
          signal.data.push(digitalToPhysical(digital, signal))
        }
      }
    }
  }

  annotations.sort((a, b) => a.onset - b.onset || a.duration - b.duration)

  const channels = allSignals
    .filter((signal) => !signal.isAnnotationSignal)
    .map((signal, index) => ({
      ...signal,
      id: index,
      isAnnotationSignal: undefined,
    }))

  return {
    header,
    totalDuration: header.numRecords * header.duration,
    channels,
    annotations,
    isEdfPlus: isEdfPlusReserved(header.reserved),
  }
}
