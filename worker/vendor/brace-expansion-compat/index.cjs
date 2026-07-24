'use strict'

const safeBraceExpansion = require('brace-expansion-safe')

function expand(pattern, options) {
  return safeBraceExpansion.expand(pattern, options)
}

// brace-expansion 1.x/2.x exported a callable CommonJS function, while 5.x
// exposes a named `expand` function. Keep both shapes so older minimatch
// releases can consume the patched implementation without a breaking upgrade.
module.exports = expand
module.exports.expand = expand
module.exports.EXPANSION_MAX = safeBraceExpansion.EXPANSION_MAX
module.exports.EXPANSION_MAX_LENGTH = safeBraceExpansion.EXPANSION_MAX_LENGTH
