const SIMPLE_EXPORT_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i

const FORBIDDEN_EXPORT_COLUMNS = [
  /(^|_)stripe(_|$)/i,
  /(^|_)(token|secret|password|credential)(_|$)/i,
  /(^|_)api_key(_|$)/i,
  /_encrypted$/i,
  /^(key|code_hash|token_hash|code_verifier|payment_reference)$/i,
  /^(payment_intent_id|checkout_session_id|invoice_id|customer_id)$/i,
  /^(public_key|private_key|auth|p256dh|endpoint|device_id|verification_data)$/i,
  /^(signup_ip_hash|attempt_count|baseline_version)$/i,
  /^(deleted_by|banned_by|muted_by|reviewed_by|resolved_by|issued_by)$/i,
  /^(anonymous_id_hash|session_id_hash|last_error|verification_error|error_message)$/i,
]

export function validateExportColumns(
  candidate: unknown,
  options: Readonly<{ requireId?: boolean }> = {}
): readonly string[] {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw new Error('Export columns must be an explicit non-empty array')
  }

  const columns = candidate.map((column) => {
    if (typeof column !== 'string' || !SIMPLE_EXPORT_IDENTIFIER.test(column)) {
      throw new Error('Unsafe export column name')
    }
    return column
  })

  if (
    new Set(columns).size !== columns.length ||
    (options.requireId === true && !columns.includes('id')) ||
    columns.some((column) => FORBIDDEN_EXPORT_COLUMNS.some((forbidden) => forbidden.test(column)))
  ) {
    throw new Error('Unsafe export column configuration')
  }

  return columns
}
