# Claude Code Skills/Commands

This directory contains custom skills (slash commands) for Claude Code, organized by category.

## Available Commands

### Code Review & Quality
- `/code-review:ai-review` - AI-powered code review with static analysis
- `/code-refactoring:refactor-clean` - Clean code refactoring with SOLID principles
- `/codebase-cleanup:tech-debt` - Technical debt analysis and remediation

### Testing
- `/tdd:tdd-cycle` - Full TDD red-green-refactor workflow
- `/unit-testing:test-generate` - Automated unit test generation

### Security
- `/security:security-scan` - SAST and vulnerability analysis
- `/security:compliance-check` - GDPR, HIPAA, SOC2 compliance

### Debugging & Monitoring
- `/debugging:smart-debug` - AI-assisted debugging workflow
- `/monitoring:monitor-setup` - Prometheus/Grafana setup
- `/incident-response:incident-response` - SRE incident response

### Git & Collaboration
- `/git-workflows:pr-enhance` - Pull request optimization
- `/team-collaboration:issue` - GitHub issue resolution

### Architecture & Documentation
- `/c4-architecture:c4-architecture` - C4 documentation generation
- `/code-documentation:doc-generate` - API docs and diagrams

### Project Scaffolding
- `/python:python-scaffold` - Python project scaffolding (FastAPI, Django)
- `/javascript-typescript:typescript-scaffold` - TypeScript project setup
- `/systems-programming:rust-project` - Rust project scaffolding

### AI/ML Development
- `/llm-development:langchain-agent` - LangChain agent development
- `/machine-learning:ml-pipeline` - MLOps pipeline design

### Data Engineering
- `/data-engineering:data-pipeline` - ETL/ELT pipeline architecture

### UI/UX
- `/ui-design:create-component` - Component scaffolding
- `/accessibility:accessibility-audit` - WCAG compliance audit

### Project Management
- `/conductor:setup` - Initialize Conductor project
- `/conductor:new-track` - Create feature/bug/chore track
- `/conductor:implement` - Execute track implementation

### Migration
- `/framework-migration:legacy-modernize` - Legacy code modernization
- `/framework-migration:deps-upgrade` - Dependency upgrade strategy

## Usage

Invoke any command using the slash syntax:

```
/category:command-name [arguments]
```

Example:
```
/tdd:tdd-cycle implement user authentication
/security:security-scan src/
/code-review:ai-review --focus security
```

## Adding New Commands

1. Create a new `.md` file in the appropriate category directory
2. Include YAML frontmatter with description and allowed-tools
3. Document the command purpose, requirements, and workflow
4. Add to this README

## Source

These commands are adapted from [wshobson/agents](https://github.com/wshobson/agents) plugins.
