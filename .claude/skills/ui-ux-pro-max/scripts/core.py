"""
UI/UX Pro Max Core - BM25 Search Engine
A search engine for UI/UX style guides using BM25 ranking algorithm.
"""

import csv
import math
import os
import re
from collections import Counter
from pathlib import Path
from typing import Optional

# Data directory path
DATA_DIR = Path(__file__).parent.parent / "data"
STACKS_DIR = DATA_DIR / "stacks"

# Domain configurations
DOMAIN_CONFIG = {
    "style": {
        "file": "styles.csv",
        "search_cols": ["Style Category", "AI Prompt Keywords", "CSS/Technical Keywords"],
        "output_cols": ["Style Category", "AI Prompt Keywords", "CSS/Technical Keywords", "Implementation Checklist", "Design System Variables"]
    },
    "prompt": {
        "file": "prompts.csv",
        "search_cols": ["Style Category", "AI Prompt Keywords"],
        "output_cols": ["Style Category", "AI Prompt Keywords", "CSS/Technical Keywords", "Implementation Checklist"]
    },
    "color": {
        "file": "colors.csv",
        "search_cols": ["Product Type", "Keywords", "Notes"],
        "output_cols": ["Product Type", "Primary", "Secondary", "CTA", "Background", "Text", "Notes"]
    },
    "chart": {
        "file": "charts.csv",
        "search_cols": ["Data Type", "Keywords", "Best Chart Type"],
        "output_cols": ["Data Type", "Best Chart Type", "Secondary Options", "Color Guidance", "Accessibility Notes", "Library Recommendation"]
    },
    "landing": {
        "file": "landing.csv",
        "search_cols": ["Pattern Name", "Keywords"],
        "output_cols": ["Pattern Name", "Section Order", "Primary CTA Placement", "Color Strategy", "Recommended Effects", "Conversion Optimization"]
    },
    "product": {
        "file": "products.csv",
        "search_cols": ["Product Type", "Keywords"],
        "output_cols": ["Product Type", "Primary Style Recommendation", "Secondary Styles", "Landing Page Pattern", "Color Palette Focus", "Key Considerations"]
    },
    "ux": {
        "file": "ux-guidelines.csv",
        "search_cols": ["Category", "Issue", "Description"],
        "output_cols": ["Category", "Issue", "Description", "Do", "Don't", "Code Example Good", "Severity"]
    },
    "typography": {
        "file": "typography.csv",
        "search_cols": ["Font Pairing Name", "Category", "Mood/Style Keywords", "Best For"],
        "output_cols": ["Font Pairing Name", "Heading Font", "Body Font", "Mood/Style Keywords", "Best For", "Google Fonts URL"]
    },
    "icons": {
        "file": "icons.csv",
        "search_cols": ["Category", "Icon Name", "Keywords"],
        "output_cols": ["Category", "Icon Name", "Keywords", "Import Code", "Usage", "Best For"]
    },
    "ui-reasoning": {
        "file": "ui-reasoning.csv",
        "search_cols": ["UI_Category", "Recommended_Pattern", "Style_Priority"],
        "output_cols": ["UI_Category", "Recommended_Pattern", "Style_Priority", "Color_Mood", "Typography_Mood", "Key_Effects", "Anti_Patterns"]
    },
    "web-interface": {
        "file": "web-interface.csv",
        "search_cols": ["Category", "Issue", "Keywords", "Description"],
        "output_cols": ["Category", "Issue", "Description", "Do", "Don't", "Code Example Good", "Severity"]
    }
}

# Stack configurations
STACK_CONFIG = {
    "html-tailwind": "html-tailwind.csv",
    "react": "react.csv",
    "nextjs": "nextjs.csv",
    "vue": "vue.csv",
    "nuxtjs": "nuxtjs.csv",
    "nuxt-ui": "nuxt-ui.csv",
    "svelte": "svelte.csv",
    "shadcn": "shadcn.csv",
    "react-native": "react-native.csv",
    "flutter": "flutter.csv",
    "swiftui": "swiftui.csv",
    "jetpack-compose": "jetpack-compose.csv"
}

STACK_COLS = {
    "search": ["Category", "Guideline", "Description", "Keywords"],
    "output": ["Category", "Guideline", "Description", "Do", "Don't", "Code Good", "Code Bad", "Severity", "Docs URL"]
}


class BM25:
    """BM25 ranking algorithm implementation."""

    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.corpus = []
        self.doc_freqs = []
        self.idf = {}
        self.avgdl = 0
        self.doc_len = []

    def fit(self, corpus: list[list[str]]):
        """Fit BM25 model to corpus."""
        self.corpus = corpus
        self.doc_len = [len(doc) for doc in corpus]
        self.avgdl = sum(self.doc_len) / len(corpus) if corpus else 0

        # Calculate document frequencies
        df = Counter()
        for doc in corpus:
            df.update(set(doc))

        # Calculate IDF
        n_docs = len(corpus)
        for word, freq in df.items():
            self.idf[word] = math.log((n_docs - freq + 0.5) / (freq + 0.5) + 1)

    def score(self, query: list[str], doc_idx: int) -> float:
        """Calculate BM25 score for a document."""
        doc = self.corpus[doc_idx]
        doc_len = self.doc_len[doc_idx]

        score = 0.0
        doc_freqs = Counter(doc)

        for term in query:
            if term not in self.idf:
                continue

            tf = doc_freqs.get(term, 0)
            idf = self.idf[term]

            numerator = tf * (self.k1 + 1)
            denominator = tf + self.k1 * (1 - self.b + self.b * doc_len / self.avgdl)

            score += idf * numerator / denominator

        return score

    def search(self, query: list[str], top_k: int = 5) -> list[tuple[int, float]]:
        """Search and return top-k document indices with scores."""
        scores = [(i, self.score(query, i)) for i in range(len(self.corpus))]
        scores.sort(key=lambda x: x[1], reverse=True)
        return scores[:top_k]


def tokenize(text: str) -> list[str]:
    """Tokenize text for search."""
    if not text:
        return []
    # Remove punctuation, lowercase, split on whitespace
    text = re.sub(r'[^\w\s]', ' ', text.lower())
    # Filter short words
    return [word for word in text.split() if len(word) >= 3]


def load_csv(filepath: Path) -> list[dict]:
    """Load CSV file and return list of dicts."""
    if not filepath.exists():
        return []

    with open(filepath, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        return list(reader)


def _search_csv(
    filepath: Path,
    query: str,
    search_cols: list[str],
    output_cols: list[str],
    top_k: int = 5
) -> list[dict]:
    """Search CSV file using BM25."""
    data = load_csv(filepath)
    if not data:
        return []

    # Build corpus from search columns
    corpus = []
    for row in data:
        text = ' '.join(str(row.get(col, '')) for col in search_cols)
        corpus.append(tokenize(text))

    # Fit BM25 and search
    bm25 = BM25()
    bm25.fit(corpus)

    query_tokens = tokenize(query)
    results = bm25.search(query_tokens, top_k)

    # Extract output columns from results
    output = []
    for idx, score in results:
        if score > 0:
            result = {col: data[idx].get(col, '') for col in output_cols if col in data[idx]}
            result['_score'] = round(score, 3)
            output.append(result)

    return output


def auto_detect_domain(query: str) -> str:
    """Auto-detect the most relevant domain from query."""
    query_lower = query.lower()

    domain_keywords = {
        "color": ["color", "palette", "theme", "vibrant", "dark", "light", "contrast"],
        "chart": ["chart", "graph", "data", "visualization", "plot", "trend", "compare"],
        "landing": ["landing", "page", "hero", "cta", "conversion", "funnel"],
        "product": ["saas", "ecommerce", "fintech", "healthcare", "app", "platform"],
        "typography": ["font", "typography", "pairing", "heading", "text", "serif"],
        "ux": ["navigation", "animation", "form", "touch", "accessibility", "responsive"],
        "icons": ["icon", "button", "action", "status", "navigation"],
        "style": ["glassmorphism", "brutalism", "minimalism", "neumorphism", "flat"]
    }

    scores = {}
    for domain, keywords in domain_keywords.items():
        scores[domain] = sum(1 for kw in keywords if kw in query_lower)

    best_domain = max(scores, key=scores.get)
    return best_domain if scores[best_domain] > 0 else "style"


def search_domain(
    domain: str,
    query: str,
    top_k: int = 5
) -> list[dict]:
    """Search a specific domain."""
    if domain not in DOMAIN_CONFIG:
        return []

    config = DOMAIN_CONFIG[domain]
    filepath = DATA_DIR / config["file"]

    return _search_csv(
        filepath,
        query,
        config["search_cols"],
        config["output_cols"],
        top_k
    )


def search_stack(
    stack: str,
    query: str,
    top_k: int = 5
) -> list[dict]:
    """Search stack-specific guidelines."""
    if stack not in STACK_CONFIG:
        stack = "html-tailwind"  # Default

    filepath = STACKS_DIR / STACK_CONFIG[stack]

    return _search_csv(
        filepath,
        query,
        STACK_COLS["search"],
        STACK_COLS["output"],
        top_k
    )


def search_auto(query: str, top_k: int = 5) -> dict:
    """Auto-detect domain and search."""
    domain = auto_detect_domain(query)
    results = search_domain(domain, query, top_k)
    return {
        "domain": domain,
        "query": query,
        "results": results
    }


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python core.py <query> [--domain <domain>] [--stack <stack>] [--top <n>]")
        sys.exit(1)

    query = sys.argv[1]
    domain = None
    stack = None
    top_k = 5

    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--domain" and i + 1 < len(sys.argv):
            domain = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--stack" and i + 1 < len(sys.argv):
            stack = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--top" and i + 1 < len(sys.argv):
            top_k = int(sys.argv[i + 1])
            i += 2
        else:
            i += 1

    if stack:
        results = search_stack(stack, query, top_k)
        print(f"Stack: {stack}")
    elif domain:
        results = search_domain(domain, query, top_k)
        print(f"Domain: {domain}")
    else:
        output = search_auto(query, top_k)
        print(f"Auto-detected domain: {output['domain']}")
        results = output['results']

    print(f"Query: {query}")
    print(f"Results: {len(results)}")
    print("-" * 40)

    for i, result in enumerate(results, 1):
        print(f"\n[{i}] Score: {result.get('_score', 'N/A')}")
        for key, value in result.items():
            if key != '_score' and value:
                print(f"  {key}: {value[:100]}..." if len(str(value)) > 100 else f"  {key}: {value}")
