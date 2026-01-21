# Python Project Scaffolding

Generate production-ready Python project structures with modern tooling (uv, FastAPI, Django).

## Requirements

Create project: **$ARGUMENTS**

## Project Types

- **FastAPI**: REST APIs, microservices, async applications
- **Django**: Full-stack web applications, admin panels
- **Library**: Reusable packages, utilities
- **CLI**: Command-line tools, automation scripts

## Initialize with uv

```bash
uv init <project-name>
cd <project-name>
uv venv
source .venv/bin/activate
```

## FastAPI Project Structure

```
project/
├── pyproject.toml
├── README.md
├── .env.example
├── src/
│   └── project_name/
│       ├── __init__.py
│       ├── main.py
│       ├── config.py
│       ├── api/
│       │   ├── v1/
│       │   │   ├── endpoints/
│       │   │   └── router.py
│       ├── core/
│       │   ├── security.py
│       │   └── database.py
│       ├── models/
│       ├── schemas/
│       └── services/
└── tests/
    ├── conftest.py
    └── api/
```

## pyproject.toml

```toml
[project]
name = "project-name"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.110.0",
    "uvicorn[standard]>=0.27.0",
    "pydantic>=2.6.0",
    "pydantic-settings>=2.1.0",
    "sqlalchemy>=2.0.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.23.0",
    "httpx>=0.26.0",
    "ruff>=0.2.0",
]

[tool.ruff]
line-length = 100
target-version = "py311"

[tool.ruff.lint]
select = ["E", "F", "I", "N", "W", "UP"]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
```

## FastAPI Main Entry

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.v1.router import api_router
from .config import settings

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api/v1")

@app.get("/health")
async def health_check():
    return {"status": "healthy"}
```

## CLI Tool Structure

```python
# cli.py
import typer
from rich.console import Console

app = typer.Typer()
console = Console()

@app.command()
def hello(name: str = typer.Option(..., "--name", "-n")):
    """Greet someone"""
    console.print(f"[bold green]Hello {name}![/bold green]")

def main():
    app()
```

## Makefile

```makefile
.PHONY: install dev test lint format

install:
	uv sync

dev:
	uv run uvicorn src.project_name.main:app --reload

test:
	uv run pytest -v

lint:
	uv run ruff check .

format:
	uv run ruff format .
```

## Output

1. **Project Structure**: Complete directory tree
2. **Configuration**: pyproject.toml with dependencies
3. **Entry Point**: Main application file
4. **Tests**: Test structure with pytest config
5. **Documentation**: README with setup instructions
6. **Development Tools**: Makefile, .env.example
