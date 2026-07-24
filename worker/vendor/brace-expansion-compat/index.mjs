import { EXPANSION_MAX, EXPANSION_MAX_LENGTH, expand as safeExpand } from 'brace-expansion-safe'

function expand(pattern, options) {
  return safeExpand(pattern, options)
}

export { EXPANSION_MAX, EXPANSION_MAX_LENGTH, expand }
export default expand
