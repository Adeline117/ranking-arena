import { useState, useEffect, useCallback, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { SECTION_IDS, type SectionId } from '../components/shared'

const DEEP_LINK_RESTORE_TIMEOUT_MS = 10_000
const ACTIVE_SECTION_TOP_OFFSET = 120

/**
 * Hook to manage active section state for settings page.
 * Handles URL param sync and scroll-based detection.
 */
export function useActiveSection() {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [activeSection, setActiveSection] = useState<SectionId>('profile')
  const manualNavigationSectionRef = useRef<SectionId | null>(null)

  // Sync from URL param
  useEffect(() => {
    const section = searchParams.get('section') as SectionId | null
    if (!section || !SECTION_IDS.includes(section)) {
      manualNavigationSectionRef.current = null
      return
    }

    setActiveSection(section)

    // A navigation-control click already performed the user-requested smooth
    // scroll. When its router.replace() updates the query, do not replace that
    // interaction with a second automatic deep-link restoration.
    if (manualNavigationSectionRef.current === section) {
      manualNavigationSectionRef.current = null
      return
    }
    manualNavigationSectionRef.current = null

    let observer: MutationObserver | null = null
    let timeout: number | null = null
    let disposed = false
    let restored = false

    const stopWaiting = () => {
      observer?.disconnect()
      observer = null
      if (timeout !== null) {
        window.clearTimeout(timeout)
        timeout = null
      }
    }

    const restoreWhenAvailable = () => {
      if (disposed || restored) return
      const target = document.getElementById(section)
      if (!target) return

      restored = true
      stopWaiting()
      target.scrollIntoView({ behavior: 'auto', block: 'start' })
    }

    restoreWhenAvailable()
    if (!restored) {
      observer = new MutationObserver(restoreWhenAvailable)
      observer.observe(document.body, { childList: true, subtree: true })
      timeout = window.setTimeout(stopWaiting, DEEP_LINK_RESTORE_TIMEOUT_MS)
    }

    return () => {
      disposed = true
      stopWaiting()
    }
  }, [searchParams])

  // Scroll-based active section detection
  useEffect(() => {
    const handleScroll = () => {
      // Bottom clamp: the page keeps 100px of trailing content padding, so the
      // last card can be fully visible while its top still sits below the active
      // section offset. Treat the final offset-sized region as the last section
      // instead of leaving the previous section highlighted.
      if (
        Math.ceil(window.innerHeight + window.scrollY) >=
        document.documentElement.scrollHeight - ACTIVE_SECTION_TOP_OFFSET
      ) {
        setActiveSection(SECTION_IDS[SECTION_IDS.length - 1])
        return
      }
      const sections = SECTION_IDS.map((id) => document.getElementById(id))
      const scrollTop = window.scrollY + ACTIVE_SECTION_TOP_OFFSET
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
        manualNavigationSectionRef.current = sectionId
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
