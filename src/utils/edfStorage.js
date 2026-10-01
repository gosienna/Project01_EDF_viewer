import { deleteBinaryMaskEditsForRecord } from './binaryMaskStorage'
import { EDF_RECORDS_STORE, openDb } from './edfDb'

export function buildEdfSummary(edfData) {
  return {
    patient: edfData.header.patient,
    recording: edfData.header.recording,
    startDate: edfData.header.startDate,
    startTime: edfData.header.startTime,
    channelCount: edfData.channels.length,
    totalDuration: edfData.totalDuration,
    isEdfPlus: edfData.isEdfPlus,
    channelLabels: edfData.channels.map((ch) => ch.label),
    importedChannelLabels: edfData.channels.filter((ch) => ch.isImported).map((ch) => ch.label),
  }
}

export async function listEdfRecords() {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(EDF_RECORDS_STORE, 'readonly')
    const store = tx.objectStore(EDF_RECORDS_STORE)
    const request = store.getAll()

    request.onsuccess = () => {
      const records = request.result
        .map(({ rawBuffer, ...rest }) => rest)
        .sort((a, b) => b.savedAt - a.savedAt)
      resolve(records)
    }
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
  })
}

export async function findEdfRecordsByFileName(fileName) {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(EDF_RECORDS_STORE, 'readonly')
    const store = tx.objectStore(EDF_RECORDS_STORE)
    const index = store.index('fileName')
    const request = index.getAll(fileName)

    request.onsuccess = () => {
      const records = (request.result ?? [])
        .map(({ rawBuffer, ...rest }) => rest)
        .sort((a, b) => b.savedAt - a.savedAt)
      resolve(records)
    }
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
  })
}

export async function saveEdfRecord(fileName, rawBuffer, summary) {
  if (!(rawBuffer instanceof ArrayBuffer)) {
    throw new Error('Invalid EDF data')
  }

  const db = await openDb()
  const now = Date.now()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(EDF_RECORDS_STORE, 'readwrite')
    const store = tx.objectStore(EDF_RECORDS_STORE)
    const request = store.add({
      fileName,
      savedAt: now,
      fileSizeBytes: rawBuffer.byteLength,
      summary,
      rawBuffer,
    })

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => reject(tx.error)
  })
}

export async function updateEdfRecord(id, fileName, rawBuffer, summary) {
  if (!(rawBuffer instanceof ArrayBuffer)) {
    throw new Error('Invalid EDF data')
  }

  const db = await openDb()
  const now = Date.now()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(EDF_RECORDS_STORE, 'readwrite')
    const store = tx.objectStore(EDF_RECORDS_STORE)
    const request = store.put({
      id,
      fileName,
      savedAt: now,
      fileSizeBytes: rawBuffer.byteLength,
      summary,
      rawBuffer,
    })

    request.onsuccess = () => resolve(id)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getEdfRecord(id) {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    const tx = db.transaction(EDF_RECORDS_STORE, 'readonly')
    const store = tx.objectStore(EDF_RECORDS_STORE)
    const request = store.get(id)

    request.onsuccess = () => {
      const record = request.result
      if (!record) {
        reject(new Error('Saved EDF not found'))
        return
      }
      resolve(record)
    }
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
  })
}

export async function deleteEdfRecord(id) {
  const db = await openDb()

  await new Promise((resolve, reject) => {
    const tx = db.transaction(EDF_RECORDS_STORE, 'readwrite')
    const store = tx.objectStore(EDF_RECORDS_STORE)
    const request = store.delete(id)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => reject(tx.error)
  })

  await deleteBinaryMaskEditsForRecord(id)
}
