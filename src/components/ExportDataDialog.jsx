import React, { useEffect, useMemo, useState } from 'react'
import { EXPORT_FORMATS, exportEdfData } from '../utils/dataExport'

const FORMAT_OPTIONS = [
  { value: EXPORT_FORMATS.EDF, label: 'EDF', description: 'European Data Format file with merged channel data' },
  { value: EXPORT_FORMATS.JSON, label: 'JSON', description: 'Channel metadata and sample values as JSON' },
  { value: EXPORT_FORMATS.CSV, label: 'CSV', description: 'Channel, sample index, time, and value per row' },
]

function ExportDataDialog({
  isOpen,
  onClose,
  channels,
  edfData,
  getChannelData,
  hasPendingChanges,
  onSaveEdf,
  isSavingEdf,
}) {
  const [format, setFormat] = useState(EXPORT_FORMATS.EDF)
  const [selectedChannelIds, setSelectedChannelIds] = useState(() => channels.map((ch) => ch.id))
  const [saveBeforeExport, setSaveBeforeExport] = useState(true)
  const [error, setError] = useState('')
  const [isExporting, setIsExporting] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    setSelectedChannelIds(channels.map((ch) => ch.id))
    setFormat(EXPORT_FORMATS.EDF)
    setSaveBeforeExport(hasPendingChanges)
    setError('')
    setIsExporting(false)
  }, [isOpen, channels, hasPendingChanges])

  const allSelected = selectedChannelIds.length === channels.length
  const noneSelected = selectedChannelIds.length === 0

  const selectedSet = useMemo(() => new Set(selectedChannelIds), [selectedChannelIds])

  const toggleChannel = (channelId) => {
    setSelectedChannelIds((prev) => (
      prev.includes(channelId)
        ? prev.filter((id) => id !== channelId)
        : [...prev, channelId]
    ))
  }

  const handleSelectAll = () => {
    setSelectedChannelIds(channels.map((ch) => ch.id))
  }

  const handleDeselectAll = () => {
    setSelectedChannelIds([])
  }

  const handleExport = async () => {
    if (noneSelected) {
      setError('Select at least one channel to export')
      return
    }

    setError('')
    setIsExporting(true)

    try {
      if (hasPendingChanges && saveBeforeExport) {
        await onSaveEdf()
      }

      exportEdfData({
        format,
        edfData,
        channelIds: selectedChannelIds,
        getChannelData,
        fileName: edfData.fileName,
        extraChannels: channels.filter((ch) => ch.isAnnotationChannel),
      })
      onClose()
    } catch (exportError) {
      setError(exportError.message || 'Export failed')
    } finally {
      setIsExporting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="export-dialog-backdrop" onClick={onClose} role="presentation">
      <div
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="export-dialog-header">
          <h3 id="export-dialog-title">Export Data</h3>
          <button className="export-dialog-close" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="export-dialog-body">
          <section className="export-dialog-section">
            <h4>Format</h4>
            <div className="export-format-options">
              {FORMAT_OPTIONS.map((option) => (
                <label key={option.value} className="export-format-option">
                  <input
                    type="radio"
                    name="export-format"
                    value={option.value}
                    checked={format === option.value}
                    onChange={() => setFormat(option.value)}
                  />
                  <span className="export-format-option-text">
                    <span className="export-format-option-label">{option.label}</span>
                    <span className="export-format-option-description">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="export-dialog-section">
            <div className="export-channel-header">
              <h4>Channels</h4>
              <div className="export-channel-actions">
                <button
                  className="btn btn-secondary btn-small"
                  type="button"
                  onClick={handleSelectAll}
                  disabled={allSelected}
                >
                  Select all
                </button>
                <button
                  className="btn btn-secondary btn-small"
                  type="button"
                  onClick={handleDeselectAll}
                  disabled={noneSelected}
                >
                  Deselect all
                </button>
              </div>
            </div>
            <div className="export-channel-list">
              {channels.map((channel) => (
                <label key={channel.id} className="export-channel-item">
                  <input
                    type="checkbox"
                    checked={selectedSet.has(channel.id)}
                    onChange={() => toggleChannel(channel.id)}
                  />
                  <span className="export-channel-label">{channel.label}</span>
                  <span className="export-channel-meta">
                    {channel.sampleRate.toFixed(1)} Hz
                    {channel.physicalDimension ? ` · ${channel.physicalDimension}` : ''}
                    {channel.isAnnotationChannel ? ' · annotation' : ''}
                  </span>
                </label>
              ))}
            </div>
          </section>

          {hasPendingChanges ? (
            <section className="export-dialog-section export-save-prompt">
              <label className="export-save-prompt-label">
                <input
                  type="checkbox"
                  checked={saveBeforeExport}
                  onChange={(event) => setSaveBeforeExport(event.target.checked)}
                />
                <span>
                  Save EDF to IndexedDB before exporting (merges binary mask edits into stored data)
                </span>
              </label>
              <p className="export-save-prompt-hint">
                You have unsaved changes. Saving first keeps IndexedDB in sync with the exported file.
              </p>
              <button
                className="btn btn-secondary btn-small"
                type="button"
                onClick={onSaveEdf}
                disabled={isSavingEdf}
              >
                {isSavingEdf ? 'Saving...' : 'Save EDF now'}
              </button>
            </section>
          ) : null}

          {error ? <p className="export-dialog-error">{error}</p> : null}
        </div>

        <div className="export-dialog-footer">
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={handleExport}
            disabled={isExporting || isSavingEdf || noneSelected}
          >
            {isExporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ExportDataDialog
