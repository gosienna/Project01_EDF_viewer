import { compressors } from 'hyparquet-compressors'
import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet'

export const PARQUET_CHANNEL_ID_BASE = 2_000_000

const SAMPLE_RATE_PATTERN = /(\d+(?:\.\d+)?)hz/i
const SAMPLE_RATE_SUFFIX_PATTERN = /[-_ ]?(\d+(?:\.\d+)?)hz$/i

/**
 * Sample rate embedded in a file name, such as `arousal_1a-2hz.parquet`.
 * @param {string} fileName
 * @returns {number | null}
 */
export function inferSampleRateFromFileName(fileName) {
  const match = String(fileName ?? '').match(SAMPLE_RATE_PATTERN)
  if (!match) return null
  const rate = Number(match[1])
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

/**
 * Filename rate, or a positive override from the import tab.
 * @param {string} fileName
 * @param {string} overrideText
 * @returns {number}
 */
export function resolveImportSampleRate(fileName, overrideText) {
  const override = String(overrideText ?? '').trim()
  if (override) {
    const rate = Number(override)
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('Sample rate must be a positive number')
    }
    return rate
  }

  const inferred = inferSampleRateFromFileName(fileName)
  if (!inferred) {
    throw new Error(`No sample rate in "${fileName}". Enter a sample rate before importing.`)
  }
  return inferred
}

function fileStem(fileName) {
  const base = String(fileName ?? '').split(/[/\\]/).pop() ?? ''
  return base.replace(/\.parquet$/i, '')
}

function stripSampleRateSuffix(stem) {
  return stem.replace(SAMPLE_RATE_SUFFIX_PATTERN, '')
}

/**
 * @param {string} fileName
 * @param {string} columnName
 * @param {number} numericColumnCount
 */
export function importChannelLabel(fileName, columnName, numericColumnCount) {
  const stem = stripSampleRateSuffix(fileStem(fileName)) || 'parquet'
  if (numericColumnCount > 1) return `${stem} · ${columnName}`
  return stem
}

/**
 * @param {string} label
 * @param {Set<string>} usedLabels
 */
export function uniqueChannelLabel(label, usedLabels) {
  if (!usedLabels.has(label)) {
    usedLabels.add(label)
    return label
  }

  let suffix = 2
  let next = `${label} (${suffix})`
  while (usedLabels.has(next)) {
    suffix += 1
    next = `${label} (${suffix})`
  }
  usedLabels.add(next)
  return next
}

/**
 * @param {unknown} value
 * @returns {number | undefined} undefined when the value is not numeric
 */
function toSample(value) {
  if (value == null) return 0
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  return undefined
}

/**
 * Read numeric columns from a parquet file.
 * Nulls become 0. Non-numeric columns are skipped.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<{ name: string, data: number[] }[]>}
 */
export async function readParquetNumericColumns(arrayBuffer) {
  const metadata = await parquetMetadataAsync(arrayBuffer)
  const schema = parquetSchema(metadata)
  const columnNames = (schema.children ?? []).map((child) => child.element.name)
  if (columnNames.length === 0) {
    throw new Error('Parquet file has no columns')
  }

  const rows = await parquetReadObjects({
    file: arrayBuffer,
    compressors,
  })
  if (rows.length === 0) {
    throw new Error('Parquet file has no rows')
  }

  const columns = []
  for (const name of columnNames) {
    const data = new Array(rows.length)
    let numeric = true
    for (let i = 0; i < rows.length; i += 1) {
      const sample = toSample(rows[i][name])
      if (sample === undefined) {
        numeric = false
        break
      }
      data[i] = sample
    }
    if (numeric) columns.push({ name, data })
  }

  if (columns.length === 0) {
    throw new Error('Parquet file has no numeric columns')
  }

  return columns
}

/**
 * @param {{
 *   id: number,
 *   label: string,
 *   data: number[],
 *   sampleRate: number,
 *   sourceFileName: string,
 * }} options
 */
export function buildImportedChannel({ id, label, data, sampleRate, sourceFileName }) {
  let physicalMin = Infinity
  let physicalMax = -Infinity
  for (let i = 0; i < data.length; i += 1) {
    const value = data[i]
    if (value < physicalMin) physicalMin = value
    if (value > physicalMax) physicalMax = value
  }
  if (!Number.isFinite(physicalMin) || !Number.isFinite(physicalMax)) {
    physicalMin = 0
    physicalMax = 1
  }

  return {
    id,
    label,
    transducer: 'Parquet import',
    physicalDimension: '',
    physicalMin,
    physicalMax,
    digitalMin: 0,
    digitalMax: 1,
    prefiltering: '',
    samplesPerRecord: sampleRate,
    sampleRate,
    data,
    isImported: true,
    sourceFileName,
  }
}
