import React, { useRef, useEffect, useState, useCallback } from 'react'
import { buildEdfSummary, deleteEdfRecord, findEdfRecordsByFileName, listEdfRecords, saveEdfRecord } from '../utils/edfStorage'
import { parseEdfFile } from '../utils/edfParser'

const TEST_EDF_FILES = [
  { fileName: 'test.edf', label: 'Load Test EDF' },
  { fileName: 'test2.edf', label: 'Load Test2 EDF (annotations)' },
]

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatSavedAt(timestamp) {
  return new Date(timestamp).toLocaleString()
}

const FileUpload = ({ onFileUpload, onLoadSavedEdf, isLoading, error }) => {
  const fileInputRef = useRef(null)
  const [savedRecords, setSavedRecords] = useState([])
  const [isLoadingSaved, setIsLoadingSaved] = useState(true)
  const [savedMessage, setSavedMessage] = useState('')
  const [savedError, setSavedError] = useState('')

  const refreshSavedRecords = useCallback(async () => {
    setIsLoadingSaved(true)
    try {
      const records = await listEdfRecords()
      setSavedRecords(records)
    } catch (listError) {
      setSavedError(listError.message || 'Failed to load saved EDF files')
    } finally {
      setIsLoadingSaved(false)
    }
  }, [])

  useEffect(() => {
    refreshSavedRecords()
  }, [refreshSavedRecords])

  const handleFileSelect = (event) => {
    const file = event.target.files[0]
    if (file && file.name.toLowerCase().endsWith('.edf')) {
      onFileUpload(file)
    } else {
      alert('Please select a valid EDF file (.edf extension)')
    }
  }

  const handleDrop = (event) => {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file && file.name.toLowerCase().endsWith('.edf')) {
      onFileUpload(file)
    } else {
      alert('Please drop a valid EDF file (.edf extension)')
    }
  }

  const handleDragOver = (event) => {
    event.preventDefault()
  }

  const handleLoadTestFile = async (fileName) => {
    setSavedError('')
    setSavedMessage('')

    try {
      const existingRecords = await findEdfRecordsByFileName(fileName)
      if (existingRecords.length > 0) {
        await onLoadSavedEdf(existingRecords[0].id)
        return
      }

      const response = await fetch(`${import.meta.env.BASE_URL}${fileName}`)
      if (!response.ok) {
        throw new Error(`Test EDF not found (${response.status})`)
      }

      const buffer = await response.arrayBuffer()
      const parsed = await parseEdfFile(buffer)
      const summary = buildEdfSummary(parsed)
      const recordId = await saveEdfRecord(fileName, buffer, summary)
      await refreshSavedRecords()
      await onLoadSavedEdf(recordId)
    } catch (loadError) {
      alert(loadError.message || 'Failed to load test EDF file')
    }
  }

  const handleLoadSaved = async (record) => {
    setSavedError('')
    setSavedMessage('')
    await onLoadSavedEdf(record.id)
  }

  const handleDeleteSaved = async (record) => {
    setSavedError('')
    setSavedMessage('')

    if (!window.confirm(`Delete saved EDF "${record.fileName}"?`)) {
      return
    }

    try {
      await deleteEdfRecord(record.id)
      await refreshSavedRecords()
      setSavedMessage(`Deleted "${record.fileName}"`)
    } catch (deleteError) {
      setSavedError(deleteError.message || 'Failed to delete saved EDF')
    }
  }

  return (
    <section className="upload-section">
      <div className="upload-container">
        <div
          className="upload-area"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="upload-icon">📁</div>
          <h2>Drop your EDF file here</h2>
          <p>or click to browse</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".edf"
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />
          <button className="browse-btn" disabled={isLoading}>
            {isLoading ? 'Processing...' : 'Browse Files'}
          </button>
        </div>

        <div className="upload-actions">
          {TEST_EDF_FILES.map((testFile) => (
            <button
              key={testFile.fileName}
              className="btn btn-secondary test-load-btn"
              onClick={() => handleLoadTestFile(testFile.fileName)}
              disabled={isLoading}
              type="button"
            >
              {testFile.label}
            </button>
          ))}
        </div>

        {error ? <p className="upload-error">{error}</p> : null}

        <div className="upload-divider" aria-hidden="true" />

        <div className="saved-edf-section">
          <div className="saved-edf-header">
            <h3>Saved EDF Files</h3>
            <p className="saved-edf-hint">
              Open files previously saved to IndexedDB, or save from the viewer after opening a file.
            </p>
          </div>

          {savedMessage ? <p className="saved-edf-message">{savedMessage}</p> : null}
          {savedError ? <p className="saved-edf-error">{savedError}</p> : null}

          {isLoadingSaved ? (
            <p className="saved-edf-empty">Loading saved files...</p>
          ) : savedRecords.length === 0 ? (
            <p className="saved-edf-empty">No saved EDF files yet.</p>
          ) : (
            <ul className="saved-edf-list">
              {savedRecords.map((record) => (
                <li key={record.id} className="saved-edf-item">
                  <div className="saved-edf-info">
                    <span className="saved-edf-name">{record.fileName}</span>
                    <span className="saved-edf-meta">
                      {record.summary.channelCount} channels · {formatDuration(record.summary.totalDuration)}
                      {record.summary.importedChannelLabels?.length
                        ? ` · ${record.summary.importedChannelLabels.length} imported`
                        : ''}
                      {record.summary.isEdfPlus ? ' · EDF+' : ''}
                      {' · '}{formatFileSize(record.fileSizeBytes)}
                      {' · Saved '}{formatSavedAt(record.savedAt)}
                    </span>
                    {(record.summary.patient || record.summary.recording) ? (
                      <span className="saved-edf-meta">
                        {[record.summary.patient, record.summary.recording].filter(Boolean).join(' · ')}
                      </span>
                    ) : null}
                  </div>
                  <div className="saved-edf-actions">
                    <button
                      className="btn btn-primary btn-small"
                      onClick={() => handleLoadSaved(record)}
                      disabled={isLoading}
                      type="button"
                    >
                      Open
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => handleDeleteSaved(record)}
                      disabled={isLoading}
                      type="button"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}

export default FileUpload
