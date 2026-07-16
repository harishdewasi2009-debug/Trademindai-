import { useState } from 'react'
import MarketPulse from './MarketPulse'
import Button from './Button'

const NAV_LINKS = ['Product', 'Models', 'Pricing', 'Docs']

export default function Hero() {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <section className="relative h-screen w-full overflow-hidden bg-ink grain">
      {/* base gradient — ink to deep teal, the page's ground */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 90% at 50% 15%, #0E2233 0%, #070B14 62%, #050810 100%)',
        }}
      />

      <MarketPulse />

      {/* subtle vignette so nav/content stay legible over the pulse line */}
      <div className="absolute inset-0 bg-gradient-to-b from-ink/40 via-transparent to-ink/70" />

      {/* Navbar */}
      <header className="fixed top-0 left-0 right-0 z-50">
        <div className="flex items-center justify-between px-6 py-5 md:px-12">
          <a href="#" className="flex items-baseline gap-2">
            <span className="font-display text-2xl italic text-paper md:text-3xl">
              TradeMind
            </span>
            <span className="font-mono text-[11px] tracking-[0.2em] text-signal">
              AI
            </span>
          </a>

          <nav className="hidden items-center gap-10 md:flex">
            {NAV_LINKS.map((link) => (
              <a
                key={link}
                href="#"
                className="text-sm tracking-wide text-paper/70 transition-colors hover:text-paper"
              >
                {link}
              </a>
            ))}
          </nav>

          <div className="hidden md:block">
            <Button>Start free</Button>
          </div>

          {/* Hamburger */}
          <button
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            className="relative z-50 flex h-8 w-8 flex-col items-center justify-center gap-[6px] md:hidden"
          >
            <span
              className="h-[1.5px] w-6 bg-paper transition-all duration-300"
              style={{
                transitionTimingFunction: 'cubic-bezier(0.22,1,0.36,1)',
                transform: menuOpen
                  ? 'rotate(45deg) translateY(7.5px)'
                  : 'none',
              }}
            />
            <span
              className="h-[1.5px] w-6 bg-paper transition-all duration-300"
              style={{
                transitionTimingFunction: 'cubic-bezier(0.22,1,0.36,1)',
                opacity: menuOpen ? 0 : 1,
                transform: menuOpen ? 'scale(0)' : 'scale(1)',
              }}
            />
            <span
              className="h-[1.5px] w-6 bg-paper transition-all duration-300"
              style={{
                transitionTimingFunction: 'cubic-bezier(0.22,1,0.36,1)',
                transform: menuOpen
                  ? 'rotate(-45deg) translateY(-7.5px)'
                  : 'none',
              }}
            />
          </button>
        </div>

        {/* Mobile menu panel */}
        <div
          className={`fixed top-0 right-0 z-40 h-screen w-[85%] max-w-[340px] border-l border-paper/10 bg-ink/95 backdrop-blur-xl transition-transform duration-500 md:hidden ${
            menuOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
          style={{ transitionTimingFunction: 'cubic-bezier(0.22,1,0.36,1)' }}
        >
          <div className="flex h-full flex-col justify-between px-8 pb-10 pt-28">
            <nav className="flex flex-col gap-6">
              {NAV_LINKS.map((link, i) => (
                <a
                  key={link}
                  href="#"
                  className="font-display text-3xl italic text-paper transition-all duration-500"
                  style={{
                    transitionDelay: menuOpen ? `${150 + i * 75}ms` : '0ms',
                    opacity: menuOpen ? 1 : 0,
                    transform: menuOpen
                      ? 'translateX(0)'
                      : 'translateX(24px)',
                  }}
                >
                  {link}
                </a>
              ))}
            </nav>
            <div
              className="transition-all duration-500"
              style={{
                transitionDelay: menuOpen ? '450ms' : '0ms',
                opacity: menuOpen ? 1 : 0,
                transform: menuOpen ? 'translateY(0)' : 'translateY(16px)',
              }}
            >
              <Button full>Start free</Button>
            </div>
          </div>
        </div>
      </header>

      {/* Center content */}
      <div className="relative z-10 flex h-full flex-col items-center justify-center px-6 text-center">
        <p className="font-mono text-xs tracking-[0.3em] text-signal/80">
          AI-NATIVE MARKET ANALYSIS
        </p>
        <h1 className="mt-5 max-w-4xl font-display text-[40px] italic leading-[1.05] text-paper md:text-7xl lg:text-[84px]">
          Market Intelligence,
          <br />
          Simplified.
        </h1>
        <p className="mt-6 max-w-xl text-sm text-paper/60 md:mt-7 md:text-base">
          TradeMindAI reads the tape, screens the noise, and hands you the
          signal — in plain language, before the crowd catches on.
        </p>
        <div className="mt-8 md:mt-10">
          <Button large>See it read a chart</Button>
        </div>
      </div>

      {/* Live indicator, bottom-left — reskinned from "sound" cue to a live-feed cue */}
      <div className="absolute bottom-8 left-8 z-10 hidden items-center gap-3 md:flex">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal/60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-signal" />
        </span>
        <div className="font-mono text-xs leading-tight text-paper/50">
          <p>Live market feed</p>
          <p>NSE · NASDAQ · LSE</p>
        </div>
      </div>
    </section>
  )
}
