'use strict';

/**
 * Service to communicate with OpenRouter API for LLM completions.
 * Includes website crawling/scraping capabilities for real-time web context injection.
 */

/**
 * Extract URLs and domain patterns from user text.
 */
function extractUrls(text) {
  if (!text || typeof text !== 'string') return [];
  const urls = [];
  
  // 1. Match standard URLs (http/https)
  const standardMatches = text.match(/(https?:\/\/[^\s]+)/gi) || [];
  urls.push(...standardMatches);

  // 2. Match domain-like names (e.g. example.com, www.example.org)
  const domainMatches = text.match(/(?:\s|^)(www\.[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?:\s|$)/gi) || [];
  domainMatches.forEach(domain => {
    const trimmed = domain.trim();
    // Skip if it contains email character or filename extension
    if (trimmed.includes('@')) return;
    if (trimmed.toLowerCase().endsWith('.js') || trimmed.toLowerCase().endsWith('.png') || trimmed.toLowerCase().endsWith('.jpg') || trimmed.toLowerCase().endsWith('.css')) return;
    
    // Skip if already captured by standard URL check
    const isMatched = urls.some(u => u.includes(trimmed));
    if (!isMatched) {
      urls.push(`https://${trimmed}`);
    }
  });

  // Limit to top 2 unique URLs to save context sizes
  return [...new Set(urls)].slice(0, 2);
}

/**
 * Validate that a URL is a safe public web URL to prevent Server-Side Request Forgery (SSRF).
 * Blocks internal loopback, private IPv4/IPv6 ranges, and cloud metadata services.
 */
function isSafeUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase().trim();

    // Disallow loopback / unspecific addresses
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0' || hostname === '[::1]') {
      return false;
    }

    // Disallow internal / local top-level domains
    if (hostname.endsWith('.internal') || hostname.endsWith('.local') || hostname.endsWith('.localhost')) {
      return false;
    }

    // Disallow private / link-local IPv4 ranges
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = hostname.match(ipv4Regex);
    if (match) {
      const b1 = parseInt(match[1], 10);
      const b2 = parseInt(match[2], 10);
      if (b1 === 0 || b1 === 10 || b1 === 127) return false;
      if (b1 === 169 && b2 === 254) return false; // AWS / GCP metadata
      if (b1 === 172 && b2 >= 16 && b2 <= 31) return false; // RFC 1918 class B
      if (b1 === 192 && b2 === 168) return false; // RFC 1918 class C
    }

    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Scrape visible text content from a target URL.
 */
async function scrapeUrlContent(url) {
  if (!isSafeUrl(url)) {
    console.warn(`[AI Scraper] Blocked disallowed or unsafe URL: ${url}`);
    return `[Webpage crawling skipped: URL is internal, private, or invalid]`;
  }

  console.log(`[AI Scraper] Fetching content from: ${url}`);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(5000) // Timeout after 5 seconds to prevent hangs
    });

    if (!response.ok) {
      return `[Failed to read webpage content: HTTP Status ${response.status}]`;
    }

    const html = await response.text();

    // Clean html by stripping scripts, styles, and html tags
    const cleanText = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 3500); // Cap content at 3500 characters to fit LLM constraints

    return cleanText || '[Webpage has no text content]';
  } catch (err) {
    console.error(`[AI Scraper] Failed to fetch URL ${url}:`, err.message);
    return `[Failed to read webpage content due to network error: ${err.message}]`;
  }
}

async function chatWithOpenRouter(messages, model) {
  const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();

  // Guard against missing or placeholder API key
  if (!apiKey || apiKey === 'your-openrouter-api-key') {
    throw new Error('OpenRouter API key is not configured. Please add your OPENROUTER_API_KEY in the backend/.env file.');
  }

  // Clone messages array to avoid side-effects
  const preparedMessages = [...messages];

  // Scrape website contents if there are URLs inside the user's latest prompt
  const lastMessage = preparedMessages[preparedMessages.length - 1];
  if (lastMessage && lastMessage.role === 'user' && typeof lastMessage.content === 'string') {
    const urls = extractUrls(lastMessage.content);
    
    if (urls.length > 0) {
      const scraperContexts = [];
      for (const url of urls) {
        const content = await scrapeUrlContent(url);
        scraperContexts.push(`[Scraped Webpage Content for URL: ${url}]\n${content}\n---`);
      }
      
      if (scraperContexts.length > 0) {
        // Prepend scraped web context as a system prompt right before user prompt
        const systemScraperContext = {
          role: 'system',
          content: `[System Notification: The user has referred to the website(s) below. We crawled them for you to answer their request. Rely on this text block to explain and reply:\n\n${scraperContexts.join('\n\n')}]`
        };
        // Insert right before the user message
        preparedMessages.splice(preparedMessages.length - 1, 0, systemScraperContext);
      }
    }
  }

  // Determine model: param > env > default
  const selectedModel = model || process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.FRONTEND_URL || process.env.APP_URL || 'https://colearn.app',
      'X-Title': 'CoLearn'
    },
    body: JSON.stringify({
      model: selectedModel,
      messages: preparedMessages,
      max_tokens: 2048
    })
  });

  const data = await response.json();

  if (!response.ok) {
    const errMsg = (data.error && data.error.message) || `HTTP error ${response.status}`;
    console.error('[OpenRouter Service] API returned error:', data.error || data);
    throw new Error(`OpenRouter API error: ${errMsg}`);
  }

  if (!data.choices || data.choices.length === 0) {
    console.error('[OpenRouter Service] Invalid API response format:', data);
    throw new Error('Invalid response received from OpenRouter API.');
  }

  return data.choices[0].message;
}

module.exports = {
  chatWithOpenRouter
};
