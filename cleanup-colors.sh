#!/bin/bash
# Cleanup script for #8b6fa8 hardcoded colors
cd /Users/adelinewen/ranking-arena

# Step 1: Update ARENA_PURPLE in lib/utils/content.ts to use token
# This is the source - change it to use the token value
# Actually, content.ts is used in places that need a raw hex value for inline styles
# So let's keep it but point to tokens

# Step 2: CSS files - replace hardcoded #8b6fa8 with var(--color-brand)
# But skip globals.css variable definitions

echo "=== Processing CSS files ==="

# animations.css
sed -i '' 's/#8b6fa8/var(--color-brand)/g' app/styles/animations.css

# trader-animations.css  
sed -i '' 's/#8b6fa8/var(--color-brand)/g' app/styles/trader-animations.css

# critical-css.ts
sed -i '' 's/#8b6fa8/var(--color-brand)/g' lib/performance/critical-css.ts

# globals.css line 681 (not the variable definitions)
# Need to be careful - only replace the usage, not the definitions

echo "Done with CSS"
