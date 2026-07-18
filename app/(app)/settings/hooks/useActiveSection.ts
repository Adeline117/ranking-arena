import { useState, useEffect, useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { SECTION_IDS, type SectionId } from '../components/shared'

/**
 * Hook to manage active section state for settings page.
 * Handles URL param sync and scroll-based detection.
 */
export function useActiveSection() {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [activeSection, setActiveSection] = useState<SectionId>('profile')

  // Sync from URL param
  useEffect(() => {
    const section = searchParams.get('section') as SectionId | null
    if (section && SECTION_IDS.includes(section)) {
      setActiveSection(section)
      const timer = window.setTimeout(() => {
        document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
      return () => window.clearTimeout(timer)
    }
  }, [searchParams])

  // Scroll-based active section detection
  useEffect(() => {
    const handleScroll = () => {
      // Bottom clamp: when the page is scrolled to (or within a couple px of) the
      // very bottom, the last section may still start below scrollY+120 — the
      // reverse loop would then pick the previous section forever. Force-select
      // the last section instead (also fixes ?section=<last> deep links).
      if (
        Math.ceil(window.innerHeight + window.scrollY) >=
        document.documentElement.scrollHeight - 2
      ) {
        setActiveSection(SECTION_IDS[SECTION_IDS.length - 1])
        return
      }
      const sections = SECTION_IDS.map((id) => document.getElementById(id))
      const scrollTop = window.scrollY + 120
      for (let i = sections.length - 1; i >= 0; i--) {
        const section = sections[i]
        if (section && section.offsetTop <= scrollTop) {
          setActiveSection(SECTION_IDS[i])
          break
        }
      }
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const scrollToSection = useCallback(
    (sectionId: SectionId) => {
      setActiveSection(sectionId)

      const params = new URLSearchParams(searchParams.toString())
      if (params.get('section') !== sectionId) {
        params.set('section', sectionId)
        const query = params.toString()
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
      }

      document.getElementById(sectionId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    },
    [pathname, router, searchParams]
  )

  return { activeSection, setActiveSection, scrollToSection }
}
