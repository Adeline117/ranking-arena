import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { SECTION_IDS, type SectionId } from '../components'

/**
 * Hook to manage active section state for settings page.
 * Handles URL param sync and scroll-based detection.
 */
export function useActiveSection() {
  const searchParams = useSearchParams()
  const [activeSection, setActiveSection] = useState<SectionId>('profile')

  // Sync from URL param
  useEffect(() => {
    const section = searchParams.get('section') as SectionId | null
    if (section && SECTION_IDS.includes(section)) {
      setActiveSection(section)
      setTimeout(() => {
        document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    }
  }, [searchParams])

  // Scroll-based active section detection
  useEffect(() => {
    const handleScroll = () => {
      const sections = SECTION_IDS.map(id => document.getElementById(id))
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

  const scrollToSection = useCallback((sectionId: SectionId) => {
    setActiveSection(sectionId)
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  return { activeSection, setActiveSection, scrollToSection }
}
