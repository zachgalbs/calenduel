// Small line icons (Lucide shapes, ISC licence), drawn in the current text
// colour. Decorative: the button around each one carries the label.
function Icon({ size = 14, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function XIcon({ size }: { size?: number }) {
  return <Icon size={size}><path d="M18 6 6 18M6 6l12 12" /></Icon>
}

export function PlusIcon({ size }: { size?: number }) {
  return <Icon size={size}><path d="M12 5v14M5 12h14" /></Icon>
}

export function ExpandIcon({ size }: { size?: number }) {
  return <Icon size={size}><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></Icon>
}

export function ShrinkIcon({ size }: { size?: number }) {
  return <Icon size={size}><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></Icon>
}

export function CheckIcon({ size }: { size?: number }) {
  return <Icon size={size}><path d="M20 6 9 17l-5-5" /></Icon>
}

export function LinkIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </Icon>
  )
}

export function DownloadIcon({ size }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5M12 15V3" />
    </Icon>
  )
}
