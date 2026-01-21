"""
UI/UX Pro Max - Design System Generator
Generates comprehensive design system recommendations based on product type and requirements.
"""

import json
from pathlib import Path
from typing import Optional

from core import (
    search_domain,
    search_stack,
    load_csv,
    DATA_DIR,
    DOMAIN_CONFIG
)


class DesignSystemGenerator:
    """Generate design system recommendations from multi-domain search."""

    def __init__(self):
        self.reasoning_rules = self._load_reasoning_rules()

    def _load_reasoning_rules(self) -> list[dict]:
        """Load UI reasoning rules from CSV."""
        filepath = DATA_DIR / "ui-reasoning.csv"
        return load_csv(filepath)

    def _find_reasoning_rule(self, product_type: str, style: str) -> Optional[dict]:
        """Find matching reasoning rule for product type and style."""
        product_lower = product_type.lower()
        style_lower = style.lower()

        # Exact match
        for rule in self.reasoning_rules:
            ui_cat = rule.get("UI_Category", "").lower()
            if product_lower in ui_cat or ui_cat in product_lower:
                return rule

        # Partial match
        for rule in self.reasoning_rules:
            ui_cat = rule.get("UI_Category", "").lower()
            keywords = product_lower.split()
            if any(kw in ui_cat for kw in keywords):
                return rule

        return None

    def generate(
        self,
        query: str,
        project_name: str = "Project",
        stack: str = "html-tailwind",
        top_k: int = 3
    ) -> dict:
        """Generate design system from query."""

        # Search across domains
        product_results = search_domain("product", query, top_k)
        style_results = search_domain("style", query, top_k)
        color_results = search_domain("color", query, top_k)
        typography_results = search_domain("typography", query, top_k)
        landing_results = search_domain("landing", query, top_k)
        ux_results = search_domain("ux", query, top_k)
        stack_results = search_stack(stack, query, top_k)

        # Get primary recommendations
        primary_product = product_results[0] if product_results else {}
        primary_style = style_results[0] if style_results else {}
        primary_color = color_results[0] if color_results else {}
        primary_typography = typography_results[0] if typography_results else {}
        primary_landing = landing_results[0] if landing_results else {}

        # Find reasoning rule
        product_type = primary_product.get("Product Type", "General")
        style_name = primary_style.get("Style Category", "Minimalism")
        reasoning = self._find_reasoning_rule(product_type, style_name)

        # Build design system
        design_system = {
            "project": project_name,
            "query": query,
            "stack": stack,
            "product_type": product_type,
            "recommendations": {
                "style": {
                    "primary": primary_style.get("Style Category", "Minimalism"),
                    "secondary": primary_product.get("Secondary Styles", ""),
                    "prompt_keywords": primary_style.get("AI Prompt Keywords", ""),
                    "css_keywords": primary_style.get("CSS/Technical Keywords", ""),
                    "checklist": primary_style.get("Implementation Checklist", "")
                },
                "colors": {
                    "primary": primary_color.get("Primary", "#2563EB"),
                    "secondary": primary_color.get("Secondary", "#64748B"),
                    "cta": primary_color.get("CTA", "#F97316"),
                    "background": primary_color.get("Background", "#FFFFFF"),
                    "text": primary_color.get("Text", "#1E293B"),
                    "notes": primary_color.get("Notes", "")
                },
                "typography": {
                    "pairing": primary_typography.get("Font Pairing Name", "Inter + System"),
                    "heading": primary_typography.get("Heading Font", "Inter"),
                    "body": primary_typography.get("Body Font", "Inter"),
                    "mood": primary_typography.get("Mood/Style Keywords", ""),
                    "google_fonts": primary_typography.get("Google Fonts URL", "")
                },
                "landing_pattern": {
                    "name": primary_landing.get("Pattern Name", "Hero + Features + CTA"),
                    "sections": primary_landing.get("Section Order", ""),
                    "cta_placement": primary_landing.get("Primary CTA Placement", ""),
                    "effects": primary_landing.get("Recommended Effects", "")
                }
            },
            "reasoning": {
                "pattern": reasoning.get("Recommended_Pattern", "") if reasoning else "",
                "color_mood": reasoning.get("Color_Mood", "") if reasoning else "",
                "typography_mood": reasoning.get("Typography_Mood", "") if reasoning else "",
                "key_effects": reasoning.get("Key_Effects", "") if reasoning else "",
                "anti_patterns": reasoning.get("Anti_Patterns", "") if reasoning else ""
            },
            "ux_guidelines": [
                {
                    "category": r.get("Category", ""),
                    "issue": r.get("Issue", ""),
                    "do": r.get("Do", ""),
                    "severity": r.get("Severity", "")
                }
                for r in ux_results[:5]
            ],
            "stack_guidelines": [
                {
                    "category": r.get("Category", ""),
                    "guideline": r.get("Guideline", ""),
                    "do": r.get("Do", ""),
                    "severity": r.get("Severity", "")
                }
                for r in stack_results[:5]
            ]
        }

        return design_system

    def format_ascii(self, design_system: dict) -> str:
        """Format design system as ASCII box."""
        width = 90
        lines = []

        def box_line(text: str = "", fill: str = " ") -> str:
            if not text:
                return "+" + "-" * (width - 2) + "+"
            return "| " + text.ljust(width - 4) + " |"

        lines.append(box_line())
        lines.append(box_line(f"DESIGN SYSTEM: {design_system['project'].upper()}"))
        lines.append(box_line(f"Query: {design_system['query']}"))
        lines.append(box_line(f"Stack: {design_system['stack']}"))
        lines.append(box_line())

        # Style
        rec = design_system["recommendations"]
        lines.append(box_line("STYLE"))
        lines.append(box_line(f"  Primary: {rec['style']['primary']}"))
        lines.append(box_line(f"  Secondary: {rec['style']['secondary']}"))
        lines.append(box_line())

        # Colors
        lines.append(box_line("COLORS"))
        colors = rec["colors"]
        lines.append(box_line(f"  Primary: {colors['primary']}  Secondary: {colors['secondary']}"))
        lines.append(box_line(f"  CTA: {colors['cta']}  Background: {colors['background']}"))
        lines.append(box_line(f"  Text: {colors['text']}"))
        lines.append(box_line())

        # Typography
        lines.append(box_line("TYPOGRAPHY"))
        typo = rec["typography"]
        lines.append(box_line(f"  Pairing: {typo['pairing']}"))
        lines.append(box_line(f"  Heading: {typo['heading']}  Body: {typo['body']}"))
        lines.append(box_line())

        # Landing Pattern
        lines.append(box_line("LANDING PATTERN"))
        landing = rec["landing_pattern"]
        lines.append(box_line(f"  Pattern: {landing['name']}"))
        lines.append(box_line(f"  CTA: {landing['cta_placement']}"))
        lines.append(box_line())

        # Anti-patterns
        reasoning = design_system["reasoning"]
        if reasoning.get("anti_patterns"):
            lines.append(box_line("ANTI-PATTERNS (AVOID)"))
            lines.append(box_line(f"  {reasoning['anti_patterns'][:80]}"))
            lines.append(box_line())

        # Checklist
        lines.append(box_line("PRE-DELIVERY CHECKLIST"))
        checklist = [
            "Color contrast meets WCAG AA (4.5:1)",
            "All interactive elements have cursor: pointer",
            "Touch targets minimum 44x44px",
            "Focus states visible and styled",
            "Loading states for async operations",
            "Reduced motion support"
        ]
        for item in checklist:
            lines.append(box_line(f"  [ ] {item}"))

        lines.append(box_line())

        return "\n".join(lines)

    def format_markdown(self, design_system: dict) -> str:
        """Format design system as Markdown."""
        rec = design_system["recommendations"]

        md = f"""# Design System: {design_system['project']}

**Query:** {design_system['query']}
**Stack:** {design_system['stack']}
**Product Type:** {design_system['product_type']}

---

## Style

- **Primary:** {rec['style']['primary']}
- **Secondary:** {rec['style']['secondary']}
- **CSS Keywords:** {rec['style']['css_keywords']}

## Colors

| Role | Value |
|------|-------|
| Primary | {rec['colors']['primary']} |
| Secondary | {rec['colors']['secondary']} |
| CTA | {rec['colors']['cta']} |
| Background | {rec['colors']['background']} |
| Text | {rec['colors']['text']} |

## Typography

- **Pairing:** {rec['typography']['pairing']}
- **Heading:** {rec['typography']['heading']}
- **Body:** {rec['typography']['body']}
- **Google Fonts:** {rec['typography']['google_fonts']}

## Landing Pattern

- **Pattern:** {rec['landing_pattern']['name']}
- **Sections:** {rec['landing_pattern']['sections']}
- **CTA Placement:** {rec['landing_pattern']['cta_placement']}
- **Effects:** {rec['landing_pattern']['effects']}

## Anti-Patterns (Avoid)

{design_system['reasoning'].get('anti_patterns', 'None specified')}

## Pre-Delivery Checklist

- [ ] Color contrast meets WCAG AA (4.5:1)
- [ ] All interactive elements have cursor: pointer
- [ ] Touch targets minimum 44x44px
- [ ] Focus states visible and styled
- [ ] Loading states for async operations
- [ ] Error states with clear feedback
- [ ] Reduced motion support
- [ ] Dark mode tested (if applicable)
- [ ] Responsive across 375px-1920px
"""
        return md


def generate_design_system(
    query: str,
    project_name: str = "Project",
    stack: str = "html-tailwind",
    format: str = "markdown"
) -> str:
    """Generate and format design system."""
    generator = DesignSystemGenerator()
    design_system = generator.generate(query, project_name, stack)

    if format == "ascii":
        return generator.format_ascii(design_system)
    elif format == "json":
        return json.dumps(design_system, indent=2)
    else:
        return generator.format_markdown(design_system)


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python design_system.py <query> [--project <name>] [--stack <stack>] [--format ascii|markdown|json]")
        sys.exit(1)

    query = sys.argv[1]
    project_name = "Project"
    stack = "html-tailwind"
    format = "markdown"

    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--project" and i + 1 < len(sys.argv):
            project_name = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--stack" and i + 1 < len(sys.argv):
            stack = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--format" and i + 1 < len(sys.argv):
            format = sys.argv[i + 1]
            i += 2
        else:
            i += 1

    output = generate_design_system(query, project_name, stack, format)
    print(output)
