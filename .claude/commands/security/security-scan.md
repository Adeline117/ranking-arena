# Security Scanning - SAST and Vulnerability Analysis

Multi-language Static Application Security Testing (SAST) scanning for Python, JavaScript/TypeScript, Java, Ruby, Go, and Rust.

## Requirements

Scan: **$ARGUMENTS**

## Tool Configuration

### Python
- **Bandit**: Security linter for Python
- **Safety**: Dependency vulnerability checking

### JavaScript/TypeScript
- **ESLint Security Plugin**: Security rules
- **npm audit**: Dependency vulnerabilities

### Multi-Language
- **Semgrep**: Custom rule authoring
- **SonarQube**: Code quality and security
- **CodeQL**: Deep semantic analysis

## Vulnerability Patterns

### Injection Vulnerabilities
- SQL Injection (CWE-89)
- Command Injection (CWE-78)
- XSS (CWE-79)
- Path Traversal (CWE-22)

### Authentication Issues
- Hardcoded Secrets (CWE-798)
- Weak Cryptography (CWE-327)
- Insecure Random (CWE-330)

### Data Exposure
- Sensitive Data Logging (CWE-532)
- Information Disclosure (CWE-200)

## Scan Process

1. **Discovery**: Identify all source files by language
2. **Tool Selection**: Match files to appropriate scanners
3. **Parallel Execution**: Run tools concurrently
4. **Result Aggregation**: Combine findings
5. **Prioritization**: Rank by severity and exploitability
6. **Reporting**: Generate actionable report

## Output Format

```json
{
  "severity": "CRITICAL|HIGH|MEDIUM|LOW",
  "cwe": "CWE-XXX",
  "file": "path/to/file.py",
  "line": 42,
  "vulnerability": "Description",
  "remediation": "How to fix",
  "references": ["link1", "link2"]
}
```

## CI/CD Integration

```yaml
# GitHub Actions
- name: Security Scan
  run: |
    semgrep scan --config=auto --sarif
    bandit -r src/ -f sarif
    npm audit --json
```

## Best Practices

1. Scan on every PR
2. Block merges for CRITICAL findings
3. Set up automated dependency updates
4. Regular full codebase scans
5. Track security debt over time
