# Security Notes

## Known Vulnerabilities

### ta-math Package (Low Risk)

The `ta-math` package (technical analysis library) contains bundled dependencies with known vulnerabilities:

- `@babel/helpers`, `@babel/runtime`, `@babel/traverse` - Build-time only
- `rollup` - Build-time only
- Various regex-related vulnerabilities

**Risk Assessment: LOW**

These vulnerabilities are mitigated because:
1. ta-math is used server-side only for technical analysis calculations
2. It doesn't process user input directly
3. The vulnerable dependencies are mostly build-time tools bundled in the package
4. The library is not exposed to client-side code

**Mitigation**: Monitor for updated versions of ta-math. Consider replacing with a more actively maintained technical analysis library if one becomes available.

## Security Practices

### Rate Limiting

- Sensitive operations (login, payments) use `failClose: true` - requests are denied when rate limiter fails
- Non-sensitive APIs use `failOpen` for availability

### CORS

- Strict allowlist in `lib/utils/cors.ts`
- Only production domains and localhost allowed

### Admin Access

- Admin status checked via database role (`user_profiles.role = 'admin'`)
- No client-side admin email exposure

### Secrets

- All secrets must be provided via environment variables
- No hardcoded secrets in code
- Shell scripts require CRON_SECRET to be set

## Reporting

Report security issues to: security@arenafi.org
