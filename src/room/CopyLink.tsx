import { useState } from 'react'
import { CheckIcon, LinkIcon } from '../icons'

// A link icon that copies your link, and turns to a tick for a moment.
export default function CopyLink({ link }: { link: string }) {
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
    <button type="button" className="icon-btn" aria-label="Copy link" title="Copy link" onClick={copy}>
      {copied ? <CheckIcon /> : <LinkIcon />}
    </button>
  )
}
