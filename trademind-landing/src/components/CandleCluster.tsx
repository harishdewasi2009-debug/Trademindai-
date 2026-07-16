/**
 * A hand-built cluster of candlesticks — the finance-world equivalent of
 * the drifting cloud imagery in the original brief. Rendered as SVG so
 * it stays crisp and needs no external asset.
 */
export default function CandleCluster({
  flipped = false,
  className = '',
}: {
  flipped?: boolean
  className?: string
}) {
  const bars = [
    { h: 60, o: 30, up: true },
    { h: 90, o: 10, up: false },
    { h: 40, o: 55, up: true },
    { h: 120, o: 5, up: true },
    { h: 70, o: 40, up: false },
    { h: 100, o: 20, up: true },
    { h: 50, o: 60, up: false },
    { h: 85, o: 15, up: true },
  ]
  const width = bars.length * 34
  const height = 220

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      style={{ transform: flipped ? 'scaleX(-1)' : undefined }}
      aria-hidden="true"
    >
      {bars.map((b, i) => {
        const x = i * 34 + 10
        const bodyTop = height - b.o - b.h
        const wickTop = bodyTop - 18
        const wickBottom = height - b.o + 14
        const color = b.up ? '#D4A24C' : '#3E5A6E'
        return (
          <g key={i} opacity={0.5}>
            <line
              x1={x + 7}
              x2={x + 7}
              y1={wickTop}
              y2={wickBottom}
              stroke={color}
              strokeWidth={1.5}
            />
            <rect
              x={x}
              y={bodyTop}
              width={14}
              height={b.h}
              fill={color}
              opacity={0.55}
              rx={1.5}
            />
          </g>
        )
      })}
    </svg>
  )
}
