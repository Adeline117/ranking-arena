# Security Testing Guide

This document outlines security testing procedures for the Ranking Arena project.

---

## Table of Contents

1. [Automated Security Scanning](#automated-security-scanning)
2. [Manual Security Testing](#manual-security-testing)
3. [Authentication & Authorization Testing](#authentication--authorization-testing)
4. [Input Validation Testing](#input-validation-testing)
5. [API Security Testing](#api-security-testing)
6. [Penetration Testing Checklist](#penetration-testing-checklist)
7. [Security Test Cases](#security-test-cases)

---

## Automated Security Scanning

### NPM Audit

Run weekly to check for known vulnerabilities:

```bash
# Basic audit
npm audit

# Detailed JSON report
npm audit --json > docs/audit-report.json

# Fix non-breaking issues
npm audit fix

# Check specific severity
npm audit --audit-level=moderate
```

**Schedule**: Every Monday

### Dependency Scanning (GitHub Dependabot)

1. Enable Dependabot in repository settings
2. Configure `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 10
    labels:
      - "dependencies"
      - "security"
```

### OWASP ZAP (Optional)

For production deployment, run OWASP ZAP scan:

```bash
# Docker-based scan
docker run -t owasp/zap2docker-stable zap-baseline.py \
  -t https://your-app.com \
  -r zap-report.html
```

---

## Manual Security Testing

### Security Headers Testing

Use [SecurityHeaders.com](https://securityheaders.com) to test:

```bash
# Or use curl
curl -I https://your-app.com | grep -E "(Content-Security-Policy|X-Frame-Options|Strict-Transport-Security)"
```

**Expected Headers**:
- `Content-Security-Policy`: Present with strict directives
- `Strict-Transport-Security`: max-age=31536000; includeSubDomains
- `X-Content-Type-Options`: nosniff
- `X-Frame-Options`: DENY
- `Referrer-Policy`: strict-origin-when-cross-origin

### SSL/TLS Testing

Test with [SSL Labs](https://www.ssllabs.com/ssltest/):

**Expected Grade**: A or A+

---

## Authentication & Authorization Testing

### Test Cases

#### 1. Unauthorized Access Prevention

```bash
# Test: Access protected API without token
curl -X POST https://your-app.com/api/posts \
  -H "Content-Type: application/json" \
  -d '{"title":"Test"}'

# Expected: 401 Unauthorized
```

#### 2. Token Validation

```bash
# Test: Invalid token
curl -X GET https://your-app.com/api/users/me \
  -H "Authorization: Bearer invalid_token"

# Expected: 401 Unauthorized
```

#### 3. Authorization Bypass Prevention

```bash
# Test: Access other user's data
curl -X GET https://your-app.com/api/users/other-user/private-data \
  -H "Authorization: Bearer your_token"

# Expected: 403 Forbidden
```

#### 4. Admin Authorization

```bash
# Test: Non-admin accessing admin endpoint
curl -X GET https://your-app.com/api/admin/users \
  -H "Authorization: Bearer non_admin_token"

# Expected: 401 Unauthorized
```

### Manual Testing Checklist

- [ ] Logout invalidates session
- [ ] Password reset requires email verification
- [ ] Failed login attempts are rate-limited
- [ ] Admin functions require admin role
- [ ] User can only access their own data
- [ ] Expired tokens are rejected

---

## Input Validation Testing

### SQL Injection Testing

Test with common SQL injection payloads:

```bash
# Test: Search with SQL injection attempt
curl -X GET "https://your-app.com/api/search?q=' OR 1=1--"

# Expected: Sanitized or error, NOT database dump
```

**Test Payloads**:
- `' OR '1'='1`
- `'; DROP TABLE users;--`
- `1' UNION SELECT * FROM users--`

### XSS Testing

Test with XSS payloads:

```bash
# Test: Create post with XSS payload
curl -X POST https://your-app.com/api/posts \
  -H "Authorization: Bearer token" \
  -H "Content-Type: application/json" \
  -d '{"title":"<script>alert(\"XSS\")</script>"}'

# Expected: Script tag escaped or sanitized
```

**Test Payloads**:
- `<script>alert('XSS')</script>`
- `<img src=x onerror=alert('XSS')>`
- `<svg onload=alert('XSS')>`
- `javascript:alert('XSS')`

### Command Injection Testing

Test file upload and processing endpoints:

```bash
# Test: Malicious filename
curl -X POST https://your-app.com/api/upload \
  -F "file=@test.jpg;filename=../../../etc/passwd"

# Expected: Filename sanitized or rejected
```

### Path Traversal Testing

```bash
# Test: Access files outside allowed directory
curl -X GET "https://your-app.com/api/files?path=../../etc/passwd"

# Expected: 403 Forbidden or sanitized path
```

### Input Length Testing

```bash
# Test: Extremely long input (DoS attempt)
curl -X POST https://your-app.com/api/posts \
  -H "Authorization: Bearer token" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"$(python -c 'print("A"*1000000)')\"}"

# Expected: 400 Bad Request (content too long)
```

---

## API Security Testing

### Rate Limiting Testing

```bash
# Test: Exceed rate limit
for i in {1..100}; do
  curl -X POST https://your-app.com/api/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@test.com","password":"wrong"}'
done

# Expected: 429 Too Many Requests after limit
```

### CORS Testing

```bash
# Test: Cross-origin request from unauthorized domain
curl -X GET https://your-app.com/api/data \
  -H "Origin: https://evil.com" \
  -H "Authorization: Bearer token"

# Expected: CORS headers should restrict or allow based on config
```

### CSRF Testing

```bash
# Test: Cross-site request forgery
curl -X POST https://your-app.com/api/posts \
  -H "Content-Type: application/json" \
  -H "Origin: https://evil.com" \
  -d '{"title":"CSRF Test"}'

# Expected: Rejected due to missing/invalid CSRF token or Origin check
```

---

## Penetration Testing Checklist

### OWASP Top 10 (2021)

#### A01: Broken Access Control
- [ ] Test unauthorized API access
- [ ] Test horizontal privilege escalation (access other user's data)
- [ ] Test vertical privilege escalation (regular user to admin)
- [ ] Test direct object reference (access resources by ID)

#### A02: Cryptographic Failures
- [ ] Verify all data in transit uses HTTPS
- [ ] Check password hashing (bcrypt/Argon2)
- [ ] Verify no sensitive data in URL parameters
- [ ] Check cookie security flags (HttpOnly, Secure, SameSite)

#### A03: Injection
- [ ] Test SQL injection in all input fields
- [ ] Test XSS in user-generated content
- [ ] Test command injection in file operations
- [ ] Test LDAP injection (if applicable)

#### A04: Insecure Design
- [ ] Review rate limiting implementation
- [ ] Check account lockout after failed attempts
- [ ] Verify business logic flaws
- [ ] Test for race conditions

#### A05: Security Misconfiguration
- [ ] Verify default credentials changed
- [ ] Check error messages don't leak info
- [ ] Verify security headers present
- [ ] Check CORS configuration

#### A06: Vulnerable Components
- [ ] Run `npm audit`
- [ ] Check for outdated dependencies
- [ ] Review third-party service security

#### A07: Authentication Failures
- [ ] Test weak password acceptance
- [ ] Test session fixation
- [ ] Test brute force protection
- [ ] Verify multi-factor authentication (if enabled)

#### A08: Software & Data Integrity Failures
- [ ] Verify npm package integrity
- [ ] Check CI/CD pipeline security
- [ ] Verify update mechanisms

#### A09: Logging & Monitoring Failures
- [ ] Verify security events are logged
- [ ] Check log tampering prevention
- [ ] Test alerting mechanisms

#### A10: Server-Side Request Forgery (SSRF)
- [ ] Test URL fetching endpoints
- [ ] Verify internal network access restrictions
- [ ] Test redirect validation

---

## Security Test Cases

### Test Suite for Critical Flows

#### User Registration
```typescript
describe('User Registration Security', () => {
  it('should reject weak passwords', async () => {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: 'test@test.com',
        password: '123', // Weak password
      }),
    })
    expect(response.status).toBe(400)
  })

  it('should prevent duplicate email registration', async () => {
    // Register once
    await registerUser('test@test.com', 'SecurePass123!')

    // Try again
    const response = await registerUser('test@test.com', 'SecurePass123!')
    expect(response.status).toBe(400)
  })

  it('should sanitize user input in profile', async () => {
    const response = await updateProfile({
      bio: '<script>alert("XSS")</script>',
    })
    const profile = await response.json()
    expect(profile.bio).not.toContain('<script>')
  })
})
```

#### API Authorization
```typescript
describe('API Authorization', () => {
  it('should prevent accessing other users data', async () => {
    const user1Token = await loginUser('user1@test.com')
    const user2Id = 'user2-id'

    const response = await fetch(`/api/users/${user2Id}/private`, {
      headers: { Authorization: `Bearer ${user1Token}` },
    })

    expect(response.status).toBe(403)
  })

  it('should require admin role for admin endpoints', async () => {
    const regularUserToken = await loginUser('regular@test.com')

    const response = await fetch('/api/admin/users', {
      headers: { Authorization: `Bearer ${regularUserToken}` },
    })

    expect(response.status).toBe(401)
  })
})
```

#### Rate Limiting
```typescript
describe('Rate Limiting', () => {
  it('should rate limit login attempts', async () => {
    const requests = Array(20).fill(null).map(() =>
      fetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'test@test.com',
          password: 'wrong',
        }),
      })
    )

    const responses = await Promise.all(requests)
    const rateLimited = responses.filter(r => r.status === 429)

    expect(rateLimited.length).toBeGreaterThan(0)
  })
})
```

---

## Security Test Schedule

### Daily (Automated)
- Unit tests with security scenarios
- Type checking
- Linting

### Weekly
- `npm audit`
- Dependency updates check
- Security header verification

### Monthly
- Full penetration testing
- Security review of new features
- Third-party security scan

### Quarterly
- Comprehensive security audit
- Update security documentation
- Team security training

---

## Tools & Resources

### Testing Tools
- [OWASP ZAP](https://www.zaproxy.org/) - Web app security scanner
- [Burp Suite](https://portswigger.net/burp) - Penetration testing toolkit
- [npm audit](https://docs.npmjs.com/cli/v8/commands/npm-audit) - Dependency scanning
- [Snyk](https://snyk.io/) - Vulnerability scanning

### Online Scanners
- [SecurityHeaders.com](https://securityheaders.com)
- [SSL Labs](https://www.ssllabs.com/ssltest/)
- [Mozilla Observatory](https://observatory.mozilla.org/)

### Documentation
- [OWASP Testing Guide](https://owasp.org/www-project-web-security-testing-guide/)
- [PortSwigger Web Security Academy](https://portswigger.net/web-security)

---

## Reporting Security Test Results

### Template

```markdown
## Security Test Report - [Date]

### Summary
- Tests Run: X
- Tests Passed: Y
- Tests Failed: Z
- Critical Issues: N

### Findings

#### Critical
- Issue description
- Steps to reproduce
- Impact
- Remediation

#### High
- ...

#### Medium
- ...

#### Low
- ...

### Recommendations
1. Action item 1
2. Action item 2

### Next Steps
- Schedule: [Date]
- Responsible: [Name]
```

---

**Last Updated**: 2026-01-28
**Next Review**: 2026-02-28
