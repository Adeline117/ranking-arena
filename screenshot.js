import { chromium } from 'playwright';

const url = 'http://localhost:3000';

async function takeScreenshots() {
  console.log('Starting screenshot process...');
  
  const browser = await chromium.launch({ 
    headless: true,
    timeout: 30000 
  });
  
  try {
    console.log('Browser launched successfully');
    
    // Desktop screenshot
    console.log('Taking desktop screenshot...');
    const desktopPage = await browser.newPage();
    await desktopPage.setViewportSize({ width: 1920, height: 1080 });
    
    try {
      console.log(`Navigating to ${url}...`);
      await desktopPage.goto(url, { timeout: 30000 });
      console.log('Page loaded, waiting for network idle...');
      
      // Wait for content to load
      await desktopPage.waitForLoadState('networkidle', { timeout: 30000 });
      console.log('Network idle achieved, waiting for animations...');
      await desktopPage.waitForTimeout(2000); // Wait for animations
      
      await desktopPage.screenshot({
        path: 'homepage-desktop.png',
        fullPage: true
      });
      console.log('✓ Desktop screenshot saved as homepage-desktop.png');
    } catch (error) {
      console.error('Error taking desktop screenshot:', error.message);
    }
    
    // Mobile screenshot  
    console.log('Taking mobile screenshot...');
    const mobilePage = await browser.newPage();
    await mobilePage.setViewportSize({ width: 375, height: 812 });
    
    try {
      console.log(`Navigating to ${url} (mobile view)...`);
      await mobilePage.goto(url, { timeout: 30000 });
      console.log('Mobile page loaded, waiting for network idle...');
      await mobilePage.waitForLoadState('networkidle', { timeout: 30000 });
      console.log('Mobile network idle achieved, waiting for animations...');
      await mobilePage.waitForTimeout(2000); // Wait for animations
      
      await mobilePage.screenshot({
        path: 'homepage-mobile.png', 
        fullPage: true
      });
      console.log('✓ Mobile screenshot saved as homepage-mobile.png');
    } catch (error) {
      console.error('Error taking mobile screenshot:', error.message);
    }
    
  } finally {
    console.log('Closing browser...');
    await browser.close();
    console.log('Screenshots complete!');
  }
}

takeScreenshots().catch(error => {
  console.error('Screenshot process failed:', error.message);
  process.exit(1);
});