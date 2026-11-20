import { useState } from 'react'

// Copies a link, and says so for a moment.
export default function CopyLink({ link, className, label = 'Copy link' }: {
  link: string
  className: string
  label?: string
}) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch (err) {
      console.error('copying the link failed', err)
    }
  }
  return (
    <button type="button" className={className} onClick={copy}>
      {copied ? 'Copied' : label}
    </button>
  )
}
