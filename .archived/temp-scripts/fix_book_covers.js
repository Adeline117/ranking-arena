#!/usr/bin/env node

/**
 * Library Cover Completion Script
 * Fetches books without covers and attempts to add cover URLs from various APIs
 */

const fetch = require('node-fetch');
const fs = require('fs').promises;

// Supabase configuration
const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE';

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

let stats = {
  totalProcessed: 0,
  coversFound: 0,
  coversUpdated: 0,
  errors: 0
};

/**
 * Fetch books without covers from Supabase in batches
 */
async function fetchBooksWithoutCovers(offset = 0, limit = 100) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/library_items?select=id,title,isbn,category&category=eq.book&cover_url=is.null&offset=${offset}&limit=${limit}`;
    
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching books:', error);
    return [];
  }
}

/**
 * Check if Open Library cover exists for ISBN
 */
async function checkOpenLibraryCover(isbn) {
  if (!isbn) return null;
  
  // Clean ISBN (remove dashes, spaces)
  const cleanIsbn = isbn.replace(/[-\s]/g, '');
  const coverUrl = `https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg`;
  
  try {
    const response = await fetch(coverUrl, { method: 'HEAD' });
    if (response.ok) {
      return coverUrl;
    }
  } catch (error) {
    console.log(`Open Library cover check failed for ISBN ${isbn}:`, error.message);
  }
  
  return null;
}

/**
 * Search Open Library by title to get cover
 */
async function searchOpenLibraryByTitle(title) {
  if (!title) return null;
  
  try {
    const searchUrl = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=1`;
    const response = await fetch(searchUrl);
    
    if (response.ok) {
      const data = await response.json();
      if (data.docs && data.docs.length > 0) {
        const book = data.docs[0];
        if (book.cover_i) {
          return `https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg`;
        }
      }
    }
  } catch (error) {
    console.log(`Open Library title search failed for "${title}":`, error.message);
  }
  
  return null;
}

/**
 * Try Google Books API as fallback
 */
async function searchGoogleBooks(isbn, title) {
  try {
    let query = '';
    if (isbn) {
      query = `isbn:${isbn.replace(/[-\s]/g, '')}`;
    } else if (title) {
      query = `intitle:"${title}"`;
    } else {
      return null;
    }
    
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1`;
    const response = await fetch(url);
    
    if (response.ok) {
      const data = await response.json();
      if (data.items && data.items.length > 0) {
        const book = data.items[0];
        if (book.volumeInfo && book.volumeInfo.imageLinks) {
          // Prefer large thumbnail, fall back to thumbnail
          return book.volumeInfo.imageLinks.large || 
                 book.volumeInfo.imageLinks.medium || 
                 book.volumeInfo.imageLinks.thumbnail;
        }
      }
    }
  } catch (error) {
    console.log(`Google Books search failed:`, error.message);
  }
  
  return null;
}

/**
 * Find cover for a book using various APIs
 */
async function findBookCover(book) {
  console.log(`\nProcessing: "${book.title}" (ISBN: ${book.isbn || 'none'})`);
  
  // Try Open Library first (by ISBN if available)
  if (book.isbn) {
    const olCover = await checkOpenLibraryCover(book.isbn);
    if (olCover) {
      console.log(`✅ Found cover via Open Library ISBN: ${olCover}`);
      return olCover;
    }
  }
  
  // Try Open Library by title
  const olTitleCover = await searchOpenLibraryByTitle(book.title);
  if (olTitleCover) {
    console.log(`✅ Found cover via Open Library title search: ${olTitleCover}`);
    return olTitleCover;
  }
  
  // Try Google Books
  const googleCover = await searchGoogleBooks(book.isbn, book.title);
  if (googleCover) {
    console.log(`✅ Found cover via Google Books: ${googleCover}`);
    return googleCover;
  }
  
  console.log(`❌ No cover found`);
  return null;
}

/**
 * Update book cover in Supabase
 */
async function updateBookCover(bookId, coverUrl) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/library_items?id=eq.${bookId}`;
    const response = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ cover_url: coverUrl })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    console.log(`💾 Updated book ${bookId} with cover: ${coverUrl}`);
    return true;
  } catch (error) {
    console.error(`Error updating book ${bookId}:`, error);
    return false;
  }
}

/**
 * Add delay between API calls to be respectful
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main processing function
 */
async function main() {
  console.log('🚀 Starting library cover completion...\n');
  
  let offset = 0;
  const batchSize = 100;
  let hasMore = true;
  
  while (hasMore) {
    console.log(`\n📖 Fetching batch ${Math.floor(offset/batchSize) + 1} (offset: ${offset})...`);
    
    const books = await fetchBooksWithoutCovers(offset, batchSize);
    
    if (books.length === 0) {
      hasMore = false;
      break;
    }
    
    console.log(`Found ${books.length} books without covers`);
    
    for (const book of books) {
      stats.totalProcessed++;
      
      try {
        const coverUrl = await findBookCover(book);
        
        if (coverUrl) {
          stats.coversFound++;
          
          const updated = await updateBookCover(book.id, coverUrl);
          if (updated) {
            stats.coversUpdated++;
          } else {
            stats.errors++;
          }
        }
        
        // Add delay between requests to be respectful to APIs
        await delay(500);
        
      } catch (error) {
        console.error(`Error processing book ${book.id}:`, error);
        stats.errors++;
      }
    }
    
    offset += batchSize;
    
    // If we got fewer books than requested, we're done
    if (books.length < batchSize) {
      hasMore = false;
    }
    
    console.log(`\n📊 Progress: ${stats.totalProcessed} processed, ${stats.coversFound} covers found, ${stats.coversUpdated} updated`);
  }
  
  // Final report
  console.log('\n🎉 Cover completion finished!');
  console.log('📊 Final Statistics:');
  console.log(`   Total books processed: ${stats.totalProcessed}`);
  console.log(`   Covers found: ${stats.coversFound}`);
  console.log(`   Successfully updated: ${stats.coversUpdated}`);
  console.log(`   Errors: ${stats.errors}`);
  console.log(`   Success rate: ${stats.totalProcessed > 0 ? ((stats.coversUpdated / stats.totalProcessed) * 100).toFixed(1) : 0}%`);
  
  // Save report
  const report = {
    timestamp: new Date().toISOString(),
    statistics: stats,
    summary: `Successfully added covers to ${stats.coversUpdated} out of ${stats.totalProcessed} books (${stats.totalProcessed > 0 ? ((stats.coversUpdated / stats.totalProcessed) * 100).toFixed(1) : 0}% success rate)`
  };
  
  await fs.writeFile('./cover_completion_report.json', JSON.stringify(report, null, 2));
  console.log('\n📄 Report saved to cover_completion_report.json');
}

// Handle errors gracefully
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

// Run the script
if (require.main === module) {
  main().catch(console.error);
}