import React, { useEffect, useRef } from 'react'

const BMC_SCRIPT_SRC = 'https://cdnjs.buymeacoffee.com/1.0.0/button.prod.min.js'

const BMC_OPTIONS = {
  text: 'Buy me a coffee',
  slug: 'keweichen',
  color: '#FFDD00',
  emoji: '',
  font: 'Cookie',
  fontColor: '#000000',
  outlineColor: '#000000',
  coffeeColor: '#ffffff',
}

function renderBmcButton(container) {
  if (!container || typeof window.bmcBtnWidget !== 'function') {
    return false
  }

  container.innerHTML = window.bmcBtnWidget(
    BMC_OPTIONS.text,
    BMC_OPTIONS.slug,
    BMC_OPTIONS.color,
    BMC_OPTIONS.emoji,
    BMC_OPTIONS.font,
    BMC_OPTIONS.fontColor,
    BMC_OPTIONS.outlineColor,
    BMC_OPTIONS.coffeeColor,
  )

  return true
}

function loadBmcScript() {
  return new Promise((resolve, reject) => {
    if (typeof window.bmcBtnWidget === 'function') {
      resolve()
      return
    }

    const existing = document.querySelector(`script[src="${BMC_SCRIPT_SRC}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Failed to load Buy Me a Coffee script')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = BMC_SCRIPT_SRC
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Buy Me a Coffee script'))
    document.head.appendChild(script)
  })
}

const Header = () => {
  const bmcRef = useRef(null)

  useEffect(() => {
    const container = bmcRef.current
    if (!container) return undefined

    let cancelled = false

    loadBmcScript()
      .then(() => {
        if (!cancelled) {
          renderBmcButton(container)
        }
      })
      .catch((error) => {
        console.error(error)
      })

    return () => {
      cancelled = true
      container.replaceChildren()
    }
  }, [])

  return (
    <header className="header">
      <div className="header-content">
        <div className="header-center">
          <h1 className="logo">
            <span className="logo-icon">📊</span>
            EDF Viewer
          </h1>
          <p className="subtitle">European Data Format Signal Viewer</p>
        </div>
        <div className="header-bmc-button" ref={bmcRef} />
      </div>
    </header>
  )
}

export default Header
