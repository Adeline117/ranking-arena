# Conductor Setup

Initialize or resume Conductor project setup. Creates foundational project documentation through interactive Q&A.

## Usage

```
/conductor:setup [--resume]
```

## Pre-flight Checks

1. Check if `conductor/` directory exists
2. Detect project type: Greenfield (new) vs Brownfield (existing)
3. Load or create setup state for tracking progress

## Interactive Q&A Protocol

**CRITICAL RULES:**
- Ask ONE question per turn
- Wait for user response
- Offer 2-3 suggested answers plus "Type your own"
- Maximum 5 questions per section

### Section 1: Product Definition (5 questions)
- Project Name
- Description
- Problem Statement
- Target Users
- Key Goals

### Section 2: Product Guidelines (3 questions)
- Voice and Tone
- Design Principles

### Section 3: Tech Stack (5 questions)
- Primary Languages
- Frontend Framework
- Backend Framework
- Database
- Infrastructure

For brownfield projects: Analyze existing code, pre-populate from package files

### Section 4: Workflow Preferences (4 questions)
- TDD Strictness
- Commit Strategy
- Code Review Requirements
- Verification Checkpoints

### Section 5: Code Style Guides (2 questions)
- Languages to Include
- Existing Conventions

## Generated Artifacts

```
conductor/
├── index.md              # Navigation hub
├── product.md            # Product definition
├── product-guidelines.md # Design guidelines
├── tech-stack.md         # Technology stack
├── workflow.md           # Development workflow
├── tracks.md             # Track registry
└── code_styleguides/     # Language-specific guides
```

## Resume Handling

If `--resume` flag is provided:
- Load previous state
- Skip completed sections
- Resume from current position
- Verify existing files

## Error Handling

- File write fails: Halt, report error, don't update state
- User cancels: Save state for future resume
- State corrupted: Offer fresh start or recovery
