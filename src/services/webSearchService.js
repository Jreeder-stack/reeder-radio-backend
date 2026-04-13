const DUCKDUCKGO_LITE_URL = 'https://lite.duckduckgo.com/lite/';
const DUCKDUCKGO_API_URL = 'https://api.duckduckgo.com/';
const SEARCH_TIMEOUT_MS = 8000;
const MAX_RESULTS = 5;

export const SEARCH_STATUS = {
  OK: 'ok',
  NO_RESULTS: 'no_results',
  ERROR: 'error'
};

export async function webSearch(query) {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return { status: SEARCH_STATUS.ERROR, text: null };
  }

  const cleanQuery = query.trim();
  console.log(`[WebSearch] Searching: "${cleanQuery}"`);

  const liteResult = await searchDuckDuckGoLite(cleanQuery);
  if (liteResult.status === SEARCH_STATUS.OK) {
    return liteResult;
  }

  const apiResult = await searchDuckDuckGoAPI(cleanQuery);
  if (apiResult.status === SEARCH_STATUS.OK) {
    return apiResult;
  }

  if (liteResult.status === SEARCH_STATUS.ERROR && apiResult.status === SEARCH_STATUS.ERROR) {
    return { status: SEARCH_STATUS.ERROR, text: null };
  }

  return { status: SEARCH_STATUS.NO_RESULTS, text: null };
}

async function searchDuckDuckGoLite(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const url = `${DUCKDUCKGO_LITE_URL}?q=${encodeURIComponent(query)}`;

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      console.error(`[WebSearch] Lite search HTTP error: ${response.status}`);
      return { status: SEARCH_STATUS.ERROR, text: null };
    }

    const html = await response.text();
    const results = parseLiteResults(html);

    if (results.length === 0) {
      console.log(`[WebSearch] Lite search: no results parsed for "${query}"`);
      return { status: SEARCH_STATUS.NO_RESULTS, text: null };
    }

    const formatted = results
      .slice(0, MAX_RESULTS)
      .map((r, i) => {
        let entry = `${i + 1}. ${r.title}`;
        if (r.snippet) entry += `\n   ${r.snippet}`;
        if (r.url) entry += `\n   URL: ${r.url}`;
        return entry;
      })
      .join('\n\n');

    const text = `Web search results for "${query}":\n\n${formatted}`;
    console.log(`[WebSearch] Lite search: found ${results.length} result(s)`);
    return { status: SEARCH_STATUS.OK, text };
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('[WebSearch] Lite search timed out');
    } else {
      console.error('[WebSearch] Lite search error:', error.message);
    }
    return { status: SEARCH_STATUS.ERROR, text: null };
  } finally {
    clearTimeout(timeout);
  }
}

function parseLiteResults(html) {
  const results = [];

  const linkPattern = /class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;
  const urlPattern = /<a[^>]+rel=["']nofollow["'][^>]+href=["']([^"']+)["'][^>]+class=['"]result-link['"][^>]*>/gi;

  const titles = [];
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    titles.push(stripHTML(match[1]).trim());
  }

  const urls = [];
  while ((match = urlPattern.exec(html)) !== null) {
    let url = match[1];
    const uddgMatch = url.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1]);
    }
    urls.push(url);
  }

  const snippets = [];
  while ((match = snippetPattern.exec(html)) !== null) {
    snippets.push(stripHTML(match[1]).trim());
  }

  for (let i = 0; i < titles.length; i++) {
    if (!titles[i] || titles[i].length < 2) continue;
    results.push({
      title: titles[i],
      url: urls[i] || '',
      snippet: snippets[i] || ''
    });
  }

  return results;
}

function stripHTML(str) {
  return str
    .replace(/<b>|<\/b>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchDuckDuckGoAPI(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      no_html: '1',
      skip_disambig: '1',
      no_redirect: '1'
    });

    const response = await fetch(`${DUCKDUCKGO_API_URL}?${params.toString()}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'CADDispatcher/1.0' }
    });

    if (!response.ok) {
      console.error(`[WebSearch] API search HTTP error: ${response.status}`);
      return { status: SEARCH_STATUS.ERROR, text: null };
    }

    const data = await response.json();
    const formatted = formatAPIResults(data, query);

    if (formatted) {
      return { status: SEARCH_STATUS.OK, text: formatted };
    }
    return { status: SEARCH_STATUS.NO_RESULTS, text: null };
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('[WebSearch] API search timed out');
    } else {
      console.error('[WebSearch] API search error:', error.message);
    }
    return { status: SEARCH_STATUS.ERROR, text: null };
  } finally {
    clearTimeout(timeout);
  }
}

function flattenRelatedTopics(topics) {
  const flat = [];
  if (!Array.isArray(topics)) return flat;
  for (const item of topics) {
    if (item.Text) {
      flat.push(item);
    } else if (item.Topics && Array.isArray(item.Topics)) {
      for (const sub of item.Topics) {
        if (sub.Text) flat.push(sub);
      }
    }
  }
  return flat;
}

function formatAPIResults(data, query) {
  const parts = [];

  if (data.AbstractText) {
    parts.push(`Summary: ${data.AbstractText}`);
    if (data.AbstractSource) parts.push(`Source: ${data.AbstractSource}`);
    if (data.AbstractURL) parts.push(`URL: ${data.AbstractURL}`);
  }

  if (data.Answer) {
    parts.push(`Answer: ${data.Answer}`);
  }

  if (data.Definition) {
    parts.push(`Definition: ${data.Definition}`);
  }

  if (data.Infobox && data.Infobox.content && data.Infobox.content.length > 0) {
    const infoItems = data.Infobox.content
      .filter(item => item.label && item.value)
      .slice(0, 8)
      .map(item => `${item.label}: ${item.value}`);
    if (infoItems.length > 0) {
      parts.push(`Info:\n${infoItems.join('\n')}`);
    }
  }

  if (data.RelatedTopics && data.RelatedTopics.length > 0) {
    const allTopics = flattenRelatedTopics(data.RelatedTopics);
    const topics = allTopics.slice(0, 5).map(t => {
      let entry = t.Text;
      if (t.FirstURL) entry += ` (${t.FirstURL})`;
      return entry;
    });
    if (topics.length > 0) {
      parts.push(`Related results:\n${topics.join('\n')}`);
    }
  }

  if (data.Results && data.Results.length > 0) {
    const results = data.Results.slice(0, 3).map(r => {
      let entry = r.Text || '';
      if (r.FirstURL) entry += ` (${r.FirstURL})`;
      return entry;
    }).filter(Boolean);
    if (results.length > 0) {
      parts.push(`Top results:\n${results.join('\n')}`);
    }
  }

  if (parts.length === 0) {
    console.log(`[WebSearch] API search: no useful results for "${query}"`);
    return null;
  }

  const result = `Web search results for "${query}":\n${parts.join('\n\n')}`;
  console.log(`[WebSearch] API search: found ${parts.length} section(s)`);
  return result;
}
