import { useEffect, useRef } from 'react'

/**
 * The page's signature element: a single signal line that draws itself
 * in on load (like a chart plotting live) then settles into a slow,
 * ambient breathing tick on the right edge — the visual equivalent of
 * "market intelligence, simplified" instead of a stock video loop.
 */
export default function MarketPulse() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches

    let width = 0
    let height = 0
    let dpr = Math.min(window.devicePixelRatio || 1, 2)

    // deterministic pseudo-random signal so it reads as "data", not noise
    const seed = 1337
    function rand(n: number) {
      const x = Math.sin(n + seed) * 10000
      return x - Math.floor(x)
    }

    const POINTS = 140
    const basePath: number[] = []
    for (let i = 0; i < POINTS; i++) {
      const t = i / POINTS
      const trend = 0.42 + t * 0.16
      const wobble =
        Math.sin(t * 14) * 0.05 +
        Math.sin(t * 37 + 2) * 0.025 +
        (rand(i) - 0.5) * 0.05
      basePath.push(trend + wobble)
    }

    let drawProgress = reducedMotion ? 1 : 0
    let tickPhase = 0
    let raf = 0

    function resize() {
      const rect = canvas!.getBoundingClientRect()
      width = rect.width
      height = rect.height
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas!.width = width * dpr
      canvas!.height = height * dpr
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    function drawGrid() {
      ctx!.strokeStyle = 'rgba(237,238,240,0.05)'
      ctx!.lineWidth = 1
      const rows = 5
      for (let r = 1; r < rows; r++) {
        const y = (height / rows) * r
        ctx!.beginPath()
        ctx!.moveTo(0, y)
        ctx!.lineTo(width, y)
        ctx!.stroke()
      }
    }

    function pathY(idx: number) {
      const v = basePath[Math.max(0, Math.min(POINTS - 1, idx))]
      return height * (1 - v)
    }

    function draw() {
      ctx!.clearRect(0, 0, width, height)
      drawGrid()

      const visiblePoints = Math.floor(POINTS * drawProgress)
      if (visiblePoints < 2) {
        raf = requestAnimationFrame(loop)
        return
      }

      // ambient tick on the trailing edge so the last segment breathes gently
      const animatedPath = [...basePath]
      if (drawProgress >= 1 && !reducedMotion) {
        for (let i = POINTS - 10; i < POINTS; i++) {
          const local = (i - (POINTS - 10)) / 10
          animatedPath[i] +=
            Math.sin(tickPhase + local * 6) * 0.012 * local
        }
      }

      ctx!.beginPath()
      for (let i = 0; i < visiblePoints; i++) {
        const x = (width / (POINTS - 1)) * i
        const v = animatedPath[i]
        const y = height * (1 - v)
        if (i === 0) ctx!.moveTo(x, y)
        else ctx!.lineTo(x, y)
      }

      // area fill under the line, gold fading to transparent
      const lastX = (width / (POINTS - 1)) * (visiblePoints - 1)
      ctx!.lineTo(lastX, height)
      ctx!.lineTo(0, height)
      ctx!.closePath()
      const fill = ctx!.createLinearGradient(0, 0, 0, height)
      fill.addColorStop(0, 'rgba(212,162,76,0.16)')
      fill.addColorStop(1, 'rgba(212,162,76,0)')
      ctx!.fillStyle = fill
      ctx!.fill()

      // the line itself
      ctx!.beginPath()
      for (let i = 0; i < visiblePoints; i++) {
        const x = (width / (POINTS - 1)) * i
        const y = height * (1 - animatedPath[i])
        if (i === 0) ctx!.moveTo(x, y)
        else ctx!.lineTo(x, y)
      }
      ctx!.strokeStyle = 'rgba(212,162,76,0.85)'
      ctx!.lineWidth = 1.5
      ctx!.shadowColor = 'rgba(212,162,76,0.55)'
      ctx!.shadowBlur = 8
      ctx!.stroke()
      ctx!.shadowBlur = 0

      // leading dot while drawing / trailing dot once settled
      const dotIdx = visiblePoints - 1
      const dotX = (width / (POINTS - 1)) * dotIdx
      const dotY = pathY(dotIdx) + (drawProgress >= 1 ? height * (1 - animatedPath[dotIdx]) - pathY(dotIdx) : 0)
      ctx!.beginPath()
      ctx!.arc(dotX, dotY, 3, 0, Math.PI * 2)
      ctx!.fillStyle = '#D4A24C'
      ctx!.fill()

      if (drawProgress < 1) drawProgress = Math.min(1, drawProgress + 0.012)
      tickPhase += 0.02

      raf = requestAnimationFrame(loop)
    }

    function loop() {
      draw()
    }

    function handleResize() {
      resize()
    }

    resize()
    raf = requestAnimationFrame(loop)
    window.addEventListener('resize', handleResize)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-x-0 bottom-0 h-[55%] w-full"
      aria-hidden="true"
    />
  )
}
