import type { ReactNode } from 'react'

export default function Button({
  children,
  large,
  full,
}: {
  children: ReactNode
  large?: boolean
  full?: boolean
}) {
  return (
    <button
      className={`rounded-full bg-signal font-body font-medium tracking-wide text-ink transition-all duration-300 hover:bg-signal/90 ${
        large ? 'px-9 py-4 text-sm md:text-base' : 'px-7 py-3 text-sm'
      } ${full ? 'w-full' : ''}`}
      style={{ boxShadow: '0 0 24px rgba(212,162,76,0.25)' }}
    >
      {children}
    </button>
  )
}
