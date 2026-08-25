function writeAsciiField(bytes, offset, length, value) {
  const encoded = new TextEncoder().encode(String(value ?? ''))
  for (let i = 0; i < length; i += 1) {
    bytes[offset + i] = i < encoded.length ? encoded[i] : 0x20
  }
}

function writeNumberField(bytes, offset, length, value) {
  writeAsciiField(bytes, offset, length, String(value))
}

export function physicalToDigital(physical, channel) {
  const digRange = channel.digitalMax - channel.digitalMin
  const physRange = channel.physicalMax - channel.physicalMin
  if (physRange === 0) return channel.digitalMin
  const digital = Math.round(
    ((physical - channel.physicalMin) / physRange) * digRange + channel.digitalMin
  )
  return Math.max(channel.digitalMin, Math.min(channel.digitalMax, digital))
}

export function buildEdfBuffer(edfData, channelIds, getChannelData) {
  const channelById = Object.fromEntries(edfData.channels.map((ch) => [ch.id, ch]))
  const channels = channelIds
    .map((id) => channelById[id])
    .filter((channel) => channel && !channel.isAnnotationChannel)

  if (channels.length === 0) {
    throw new Error('No channels selected for export')
  }

  const { header } = edfData
  const numSignals = channels.length
  const headerBytes = 256 + numSignals * 256
  const numRecords = header.numRecords
  const duration = header.duration

  let dataBytes = 0
  channels.forEach((channel) => {
    dataBytes += numRecords * channel.samplesPerRecord * 2
  })

  const buffer = new ArrayBuffer(headerBytes + dataBytes)
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)

  writeAsciiField(bytes, 0, 8, header.version || '0')
  writeAsciiField(bytes, 8, 80, header.patient)
  writeAsciiField(bytes, 88, 80, header.recording)
  writeAsciiField(bytes, 168, 8, header.startDate)
  writeAsciiField(bytes, 176, 8, header.startTime)
  writeNumberField(bytes, 184, 8, headerBytes)
  writeAsciiField(bytes, 192, 44, header.reserved)
  writeNumberField(bytes, 236, 8, numRecords)
  writeNumberField(bytes, 244, 8, duration)
  writeNumberField(bytes, 252, 4, numSignals)

  channels.forEach((channel, index) => {
    writeAsciiField(bytes, 256 + numSignals * 0 + index * 16, 16, channel.label)
    writeAsciiField(bytes, 256 + numSignals * 16 + index * 80, 80, channel.transducer)
    writeAsciiField(bytes, 256 + numSignals * 96 + index * 8, 8, channel.physicalDimension)
    writeNumberField(bytes, 256 + numSignals * 104 + index * 8, 8, channel.physicalMin)
    writeNumberField(bytes, 256 + numSignals * 112 + index * 8, 8, channel.physicalMax)
    writeNumberField(bytes, 256 + numSignals * 120 + index * 8, 8, channel.digitalMin)
    writeNumberField(bytes, 256 + numSignals * 128 + index * 8, 8, channel.digitalMax)
    writeAsciiField(bytes, 256 + numSignals * 136 + index * 80, 80, channel.prefiltering)
    writeNumberField(bytes, 256 + numSignals * 216 + index * 8, 8, channel.samplesPerRecord)
  })

  let offset = headerBytes
  for (let record = 0; record < numRecords; record += 1) {
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const channel = channels[channelIndex]
      const data = getChannelData(channel.id) ?? channel.data
      const spr = channel.samplesPerRecord
      const startSample = record * spr

      for (let sample = 0; sample < spr; sample += 1) {
        const physical = data[startSample + sample] ?? 0
        view.setInt16(offset, physicalToDigital(physical, channel), true)
        offset += 2
      }
    }
  }

  return buffer
}
