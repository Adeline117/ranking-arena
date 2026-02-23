#!/usr/bin/env python3
"""
UI/UX Pro Max Search CLI
Search engine for UI/UX style guides with design system generation.
"""

import argparse
import json
import sys
from pathlib import Path

from core import (
    search_domain,
    search_stack,
    search_auto,
    DOMAIN_CONFIG,
    STACK_CONFIG
)
from design_system import generate_design_system


def format_results(results: list[dict], format: str = "default") -> str:
    """Format search results for output."""
    if format == "json":
        return json.dumps(results, indent=2)

    if not results:
        return "No results found."

    lines = []
    for i, result in enumerate(results, 1):
        score = result.pop('_score', None)
        lines.append(f"\n--- Result {i}" + (f" (score: {score})" if score else "") + " ---")
        for key, value in result.items():
            if value:
                # Truncate long values
                val_str = str(value)
                if len(val_str) > 120:
                    val_str = val_str[:117] + "..."
                lines.append(f"{key}: {val_str}")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="UI/UX Pro Max Search - Style Guide Search Engine",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Auto-detect domain and search
  python search.py "saas dashboard dark mode"

  # Search specific domain
  python search.py "glassmorphism cards" --domain style

  # Search stack-specific guidelines
  python search.py "performance optimization" --stack nextjs

  # Generate complete design system
  python search.py "crypto trading platform" --design-system

  # Generate design system with specific stack
  python search.py "healthcare app" --design-system --stack react-native --format ascii

  # Persist design system to files
  python search.py "ecommerce luxury" --design-system --persist

Available Domains:
  style, prompt, color, chart, landing, product, ux, typography, icons, ui-reasoning, web-interface

Available Stacks:
  html-tailwind, react, nextjs, vue, nuxtjs, nuxt-ui, svelte, shadcn, react-native, flutter, swiftui, jetpack-compose
"""
    )

    parser.add_argument("query", help="Search query")
    parser.add_argument("--domain", "-d", choices=list(DOMAIN_CONFIG.keys()),
                        help="Search specific domain")
    parser.add_argument("--stack", "-s", choices=list(STACK_CONFIG.keys()),
                        help="Search stack-specific guidelines")
    parser.add_argument("--top", "-n", type=int, default=5,
                        help="Number of results (default: 5)")
    parser.add_argument("--format", "-f", choices=["default", "json", "ascii", "markdown"],
                        default="default", help="Output format")
    parser.add_argument("--design-system", "-ds", action="store_true",
                        help="Generate complete design system recommendation")
    parser.add_argument("--project", "-p", default="Project",
                        help="Project name for design system")
    parser.add_argument("--persist", action="store_true",
                        help="Persist design system to files (requires --design-system)")

    args = parser.parse_args()

    # Generate design system
    if args.design_system:
        stack = args.stack or "html-tailwind"
        format = args.format if args.format in ["ascii", "markdown", "json"] else "markdown"

        output = generate_design_system(
            args.query,
            args.project,
            stack,
            format
        )

        if args.persist:
            # Create design-system directory
            output_dir = Path("design-system")
            output_dir.mkdir(exist_ok=True)

            # Write MASTER.md
            master_path = output_dir / "MASTER.md"
            master_content = generate_design_system(args.query, args.project, stack, "markdown")
            with open(master_path, 'w') as f:
                f.write(master_content)
            print(f"Design system saved to: {master_path}")

            # Write JSON config
            config_path = output_dir / "config.json"
            config_content = generate_design_system(args.query, args.project, stack, "json")
            with open(config_path, 'w') as f:
                f.write(config_content)
            print(f"Config saved to: {config_path}")
        else:
            print(output)

        return

    # Search stack-specific guidelines
    if args.stack:
        results = search_stack(args.stack, args.query, args.top)
        print(f"Stack: {args.stack}")
        print(f"Query: {args.query}")
        print(f"Results: {len(results)}")
        print(format_results(results, args.format))
        return

    # Search specific domain
    if args.domain:
        results = search_domain(args.domain, args.query, args.top)
        print(f"Domain: {args.domain}")
        print(f"Query: {args.query}")
        print(f"Results: {len(results)}")
        print(format_results(results, args.format))
        return

    # Auto-detect domain and search
    output = search_auto(args.query, args.top)
    print(f"Auto-detected domain: {output['domain']}")
    print(f"Query: {args.query}")
    print(f"Results: {len(output['results'])}")
    print(format_results(output['results'], args.format))


if __name__ == "__main__":
    main()
