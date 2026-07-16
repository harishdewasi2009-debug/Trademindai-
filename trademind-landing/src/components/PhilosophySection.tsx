import { useEffect, useRef } from 'react'
import CandleCluster from './CandleCluster'

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}
function lerp(current: number, target: number, factor: number) {
  return current + (target - current) * factor
}

export default function PhilosophySection() {
  const sectionRef = useRef<HTMLElement>(null)
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches

    let target = { leftX: -220, leftY: 0, rightX: 220, rightY: 0, opacity: 0 }
    let current = { ...target }
    let raf = 0

    function update() {
      const section = sectionRef.current
      if (!section) {
        raf = requestAnimationFrame(update)
        return
      }
      const rect = section.getBoundingClientRect()
      const windowHeight = window.innerHeight
      const progress = clamp(
        (windowHeight - rect.top) / (windowHeight + rect.height),
        0,
        1,
      )

      const inView = progress > 0.12 && progress < 0.92
      const cloudY = progress * -40

      target = {
        leftX: inView ? 0 : -220,
        rightX: inView ? 0 : 220,
        leftY: cloudY,
        rightY: cloudY,
        opacity: inView ? 1 : 0,
      }

      if (reducedMotion) {
        current = { ...target }
      } else {
        current.leftX = lerp(current.leftX, target.leftX, 0.06)
        current.rightX = lerp(current.rightX, target.rightX, 0.06)
        current.leftY = lerp(current.leftY, target.leftY, 0.06)
        current.rightY = lerp(current.rightY, target.rightY, 0.06)
        current.opacity = lerp(current.opacity, target.opacity, 0.08)
      }

      if (leftRef.current) {
        leftRef.current.style.transform = `translate3d(${current.leftX}px, ${current.leftY}px, 0)`
        leftRef.current.style.opacity = String(current.opacity)
      }
      if (rightRef.current) {
        rightRef.current.style.transform = `translate3d(${current.rightX}px, ${current.rightY}px, 0)`
        rightRef.current.style.opacity = String(current.opacity)
      }

      raf = requestAnimationFrame(update)
    }

    raf = requestAnimationFrame(update)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <section
      ref={sectionRef}
      className="relative h-screen w-full overflow-hidden"
      style={{
        background:
          'linear-gradient(180deg, #050810 0%, #0C2233 32%, #16455B 64%, #2C6E85 100%)',
      }}
    >
      {/* left candle cluster */}
      <div
        ref={leftRef}
        className="pointer-events-none absolute bottom-[8%] left-0 z-10 hidden will-change-transform sm:block"
        style={{ marginLeft: '-6%', opacity: 0 }}
      >
        <div className="w-[320px] md:w-[420px]">
          <div style={{ transform: 'scale(1.4)', transformOrigin: 'bottom left' }}>
            <CandleClusterLazy />
          </div>
        </div>
      </div>

      {/* right candle cluster */}
      <div
        ref={rightRef}
        className="pointer-events-none absolute bottom-[13%] right-0 z-10 hidden will-change-transform sm:block"
        style={{ marginRight: '-6%', opacity: 0 }}
      >
        <div className="w-[320px] md:w-[420px]">
          <div style={{ transform: 'scale(1.4)', transformOrigin: 'bottom right' }}>
            <CandleClusterLazy flipped />
          </div>
        </div>
      </div>

      {/* thesis content */}
      <div className="relative z-20 flex h-full max-w-4xl flex-col items-center justify-center px-6 text-center mx-auto">
        <p className="font-mono text-xs tracking-[0.3em] text-paper/50">
          OUR APPROACH
        </p>
        <p className="mt-6 font-display text-xl italic leading-[1.5] text-paper sm:text-2xl md:text-4xl lg:text-[42px] md:leading-[1.5]">
          &ldquo;Markets don&rsquo;t need another dashboard. They need someone
          to tell you what actually changed, why it matters, and what to
          watch next — before the headline writes itself.&rdquo;
        </p>
        <p className="mt-6 text-sm tracking-wide text-paper/70 md:mt-8 md:text-base">
          — The TradeMindAI Desk
        </p>
      </div>
    </section>
  )
}

function CandleClusterLazy({ flipped }: { flipped?: boolean }) {
  return <CandleCluster flipped={flipped} className="w-full h-auto" />
}
