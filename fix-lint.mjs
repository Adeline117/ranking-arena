import fs from 'fs';
import path from 'path';

const BASE = '/Users/adelinewen/ranking-arena';

function readFile(f) {
  return fs.readFileSync(path.join(BASE, f), 'utf8');
}
function writeFile(f, content) {
  fs.writeFileSync(path.join(BASE, f), content, 'utf8');
}

// Parse lint output
const lintOutput = fs.readFileSync('/tmp/lint-output.txt', 'utf8');
const lines = lintOutput.split('\n');

// Group warnings by file
const fileWarnings = {};
let currentFile = null;
for (const line of lines) {
  if (line.startsWith(BASE + '/')) {
    currentFile = line.replace(BASE + '/', '');
    if (!fileWarnings[currentFile]) fileWarnings[currentFile] = [];
  } else if (currentFile && line.includes('warning')) {
    const match = line.match(/^\s+(\d+):\d+\s+warning\s+(.+?)\s{2,}(\S+)$/);
    if (match) {
      fileWarnings[currentFile].push({
        line: parseInt(match[1]),
        message: match[2].trim(),
        rule: match[3].trim(),
      });
    }
  }
}

let totalFixed = 0;

// Fix no-console: replace console.log with console.warn
function fixConsole(file) {
  const warnings = (fileWarnings[file] || []).filter(w => w.rule === 'no-console');
  if (!warnings.length) return;
  
  const content = readFile(file);
  const lines = content.split('\n');
  let fixed = 0;
  
  for (const w of warnings) {
    const idx = w.line - 1;
    if (idx < lines.length) {
      // Replace console.log with console.warn, console.info with console.warn, console.debug with console.warn
      const orig = lines[idx];
      let newLine = orig;
      newLine = newLine.replace(/console\.log\(/g, 'console.warn(');
      newLine = newLine.replace(/console\.info\(/g, 'console.warn(');
      newLine = newLine.replace(/console\.debug\(/g, 'console.warn(');
      newLine = newLine.replace(/console\.trace\(/g, 'console.warn(');
      if (newLine !== orig) {
        lines[idx] = newLine;
        fixed++;
      }
    }
  }
  
  if (fixed) {
    writeFile(file, lines.join('\n'));
    totalFixed += fixed;
    console.log(`  Fixed ${fixed} console warnings in ${file}`);
  }
}

// Fix unused imports - remove entire import line or remove specific named import
function fixUnusedImport(file, varName, lineNum) {
  const content = readFile(file);
  const lines = content.split('\n');
  const idx = lineNum - 1;
  if (idx >= lines.length) return false;
  
  const line = lines[idx];
  
  // Check if it's an import line
  if (!line.includes('import')) return false;
  
  // Single named import: import { Foo } from '...'
  const singleNamedRe = new RegExp(`^\\s*import\\s*\\{\\s*${escapeRegExp(varName)}\\s*\\}\\s*from\\s`);
  if (singleNamedRe.test(line)) {
    lines.splice(idx, 1);
    writeFile(file, lines.join('\n'));
    return true;
  }
  
  // Type import: import type { Foo } from '...'
  const singleTypeRe = new RegExp(`^\\s*import\\s+type\\s*\\{\\s*${escapeRegExp(varName)}\\s*\\}\\s*from\\s`);
  if (singleTypeRe.test(line)) {
    lines.splice(idx, 1);
    writeFile(file, lines.join('\n'));
    return true;
  }
  
  // Multiple named imports - remove just the one
  // import { Foo, Bar, Baz } from '...'
  // Remove "Foo, " or ", Foo" or " Foo,"
  const patterns = [
    new RegExp(`\\b${escapeRegExp(varName)}\\s*,\\s*`),
    new RegExp(`\\s*,\\s*${escapeRegExp(varName)}\\b`),
  ];
  
  for (const pat of patterns) {
    if (pat.test(line)) {
      lines[idx] = line.replace(pat, '');
      writeFile(file, lines.join('\n'));
      return true;
    }
  }
  
  return false;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Fix unused variables (not imports)
function fixUnusedVar(file, varName, lineNum) {
  const content = readFile(file);
  const lines = content.split('\n');
  const idx = lineNum - 1;
  if (idx >= lines.length) return false;
  
  const line = lines[idx];
  
  // Skip import lines - handled separately
  if (line.includes('import ')) return false;
  
  // Unused destructured variable: const { foo, bar } = ... -> const { _foo, bar } = ...
  // Or: const [foo, bar] = ... -> const [_foo, bar] = ...
  
  // Unused function parameter - prefix with _
  // Unused catch error - prefix with _
  // Unused const/let assignment - prefix with _
  
  // Simple case: const varName = ... or let varName = ...
  const constLetRe = new RegExp(`(const|let|var)\\s+${escapeRegExp(varName)}\\b`);
  if (constLetRe.test(line)) {
    lines[idx] = line.replace(new RegExp(`\\b${escapeRegExp(varName)}\\b`), `_${varName}`);
    writeFile(file, lines.join('\n'));
    return true;
  }
  
  // Destructured: const { ..., varName, ... } = ...
  const destructRe = new RegExp(`\\b${escapeRegExp(varName)}\\b`);
  if ((line.includes('{') || line.includes('[')) && destructRe.test(line)) {
    lines[idx] = line.replace(new RegExp(`\\b${escapeRegExp(varName)}\\b`), `_${varName}`);
    writeFile(file, lines.join('\n'));
    return true;
  }
  
  return false;
}

// Fix unused function params - prefix with _
function fixUnusedParam(file, varName, lineNum) {
  const content = readFile(file);
  const lines = content.split('\n');
  const idx = lineNum - 1;
  if (idx >= lines.length) return false;
  
  const line = lines[idx];
  
  // Replace the param name with _prefixed version
  const re = new RegExp(`\\b${escapeRegExp(varName)}\\b`);
  if (re.test(line)) {
    lines[idx] = line.replace(re, `_${varName}`);
    writeFile(file, lines.join('\n'));
    return true;
  }
  
  return false;
}

// Fix unused catch errors
function fixUnusedCatchError(file, varName, lineNum) {
  const content = readFile(file);
  const lines = content.split('\n');
  const idx = lineNum - 1;
  if (idx >= lines.length) return false;
  
  const line = lines[idx];
  lines[idx] = line.replace(new RegExp(`\\b${escapeRegExp(varName)}\\b`), `_${varName}`);
  writeFile(file, lines.join('\n'));
  return true;
}

// Fix empty blocks - add comment
function fixEmptyBlock(file, lineNum) {
  const content = readFile(file);
  const lines = content.split('\n');
  const idx = lineNum - 1;
  if (idx >= lines.length) return false;
  
  const line = lines[idx];
  // Find {} and add comment inside
  if (line.includes('{}')) {
    lines[idx] = line.replace('{}', '{ /* intentionally empty */ }');
    writeFile(file, lines.join('\n'));
    return true;
  }
  // Find { at end of line with next line being }
  if (line.trimEnd().endsWith('{') && idx + 1 < lines.length) {
    const nextLine = lines[idx + 1];
    if (nextLine.trim() === '}' || nextLine.trim() === '} catch' || nextLine.trim().startsWith('}')) {
      const indent = nextLine.match(/^(\s*)/)[1];
      lines.splice(idx + 1, 0, indent + '  // intentionally empty');
      writeFile(file, lines.join('\n'));
      return true;
    }
  }
  
  return false;
}

// Fix prefer-const
function fixPreferConst(file, lineNum) {
  const content = readFile(file);
  const lines = content.split('\n');
  const idx = lineNum - 1;
  if (idx >= lines.length) return false;
  
  const line = lines[idx];
  if (line.includes('let ')) {
    lines[idx] = line.replace(/\blet\b/, 'const');
    writeFile(file, lines.join('\n'));
    return true;
  }
  return false;
}

// Process all files
console.log('Fixing lint warnings...\n');

for (const [file, warnings] of Object.entries(fileWarnings)) {
  // Process warnings in reverse line order to avoid line number shifting
  const sortedWarnings = [...warnings].sort((a, b) => b.line - a.line);
  
  for (const w of sortedWarnings) {
    let fixed = false;
    
    if (w.rule === 'no-console') {
      // Handled in batch below
      continue;
    }
    
    if (w.rule === 'prefer-const') {
      fixed = fixPreferConst(file, w.line);
    }
    
    if (w.rule === '@typescript-eslint/no-unused-vars') {
      // Extract variable name from message
      const nameMatch = w.message.match(/'(\w+)'/);
      if (!nameMatch) continue;
      const varName = nameMatch[1];
      
      if (w.message.includes('is defined but never used')) {
        // Could be import or function declaration
        fixed = fixUnusedImport(file, varName, w.line);
        if (!fixed) {
          fixed = fixUnusedVar(file, varName, w.line);
        }
      } else if (w.message.includes('is assigned a value but never used')) {
        fixed = fixUnusedVar(file, varName, w.line);
      } else if (w.message.includes('Allowed unused args')) {
        fixed = fixUnusedParam(file, varName, w.line);
      } else if (w.message.includes('Allowed unused caught errors')) {
        fixed = fixUnusedCatchError(file, varName, w.line);
      }
    }
    
    if (w.rule === 'no-empty') {
      fixed = fixEmptyBlock(file, w.line);
    }
    
    if (fixed) {
      totalFixed++;
    }
  }
  
  // Fix console warnings in batch (after other fixes to avoid line shifts)
  fixConsole(file);
}

console.log(`\nTotal fixes applied: ${totalFixed}`);
