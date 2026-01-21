# Accessibility Audit - WCAG Compliance

Comprehensive audit of UI code for WCAG 2.1/2.2 compliance with actionable remediation guidance.

## Target

Audit: **$ARGUMENTS**

## Compliance Level

Default: WCAG 2.1 Level AA
Options: --level AA | --level AAA

## WCAG Criteria Categories

### Perceivable (WCAG 1.x)

**1.1 Text Alternatives**
- [ ] Images have meaningful alt text
- [ ] Decorative images have empty alt=""
- [ ] Icons have ARIA labels

**1.3 Adaptable**
- [ ] Semantic HTML elements used
- [ ] Heading hierarchy is logical (h1 → h2 → h3)
- [ ] Lists use proper ul/ol/li elements

**1.4 Distinguishable**
- [ ] Color contrast meets ratios:
  - Normal text: 4.5:1 (AA), 7:1 (AAA)
  - Large text: 3:1 (AA), 4.5:1 (AAA)
  - UI components: 3:1
- [ ] Text resizable to 200% without loss
- [ ] No images of text

### Operable (WCAG 2.x)

**2.1 Keyboard Accessible**
- [ ] All functionality available via keyboard
- [ ] No keyboard traps
- [ ] Skip links provided

**2.4 Navigable**
- [ ] Page has descriptive title
- [ ] Focus order is logical
- [ ] Focus indicator visible (outline)
- [ ] Link purpose clear from text

**2.5 Input Modalities**
- [ ] Touch targets minimum 44x44px
- [ ] Gestures have alternatives

### Understandable (WCAG 3.x)

**3.1 Readable**
- [ ] Page language specified (lang attribute)
- [ ] Abbreviations explained

**3.2 Predictable**
- [ ] Navigation consistent across pages
- [ ] Components behave predictably

**3.3 Input Assistance**
- [ ] Form fields have labels
- [ ] Error messages are descriptive
- [ ] Required fields indicated

### Robust (WCAG 4.x)

**4.1 Compatible**
- [ ] Valid HTML
- [ ] ARIA used correctly
- [ ] Status messages announced

## Common Anti-Patterns

```html
<!-- Bad: onClick without keyboard -->
<div onclick="doThing()">Click me</div>

<!-- Good: Button with keyboard support -->
<button onclick="doThing()">Click me</button>

<!-- Bad: Missing label -->
<input type="text" placeholder="Email" />

<!-- Good: Proper label -->
<label for="email">Email</label>
<input id="email" type="text" />

<!-- Bad: Non-semantic button -->
<span class="button">Submit</span>

<!-- Good: Semantic button -->
<button type="submit">Submit</button>
```

## Testing Tools

- **Automated**: axe-core, Lighthouse, WAVE
- **Manual**: Keyboard navigation, Screen reader testing
- **Color**: Contrast checker tools

## Report Format

```markdown
## Executive Summary
- Compliance Status: PASS/FAIL
- Critical Issues: X
- Serious Issues: X
- Moderate Issues: X

## Issues
### [Critical] Missing form labels
- **File**: src/components/Form.tsx:42
- **WCAG**: 3.3.2 Labels or Instructions
- **Fix**: Add label elements for all inputs

## Recommendations
### Quick Wins
- Add alt text to images
- Add lang attribute to html

### Medium Effort
- Implement skip links
- Fix heading hierarchy
```
