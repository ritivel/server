/*
 * Regulatory Search Handler
 * 
 * This module provides an AI-powered regulatory document search endpoint with:
 * - Query decomposition using LLM
 * - Hybrid search (vector + keyword) via OpenSearch Serverless
 * - Streaming responses via Server-Sent Events (SSE)
 * - LLM-generated answers with source citations
 */

'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// Configuration from Searchbot.txt
const CONFIG = {
  OPENSEARCH_ENDPOINT: process.env.OPENSEARCH_ENDPOINT || 'https://7tbmk7oto03rovtmipb.us-east-1.aoss.amazonaws.com',
  OPENSEARCH_INDEX: process.env.OPENSEARCH_INDEX || 'regulatory-chunks',
  AWS_REGION: process.env.AWS_REGION || 'us-east-1',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '',
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || ''
};

/**
 * AWS Signature V4 signing for OpenSearch Serverless (aoss)
 */
function signRequest(method, url, body, service = 'aoss') {
  const parsedUrl = new URL(url);
  const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = datetime.substring(0, 8);
  
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex');
  
  const headers = {
    'content-type': 'application/json',
    'host': parsedUrl.host,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date': datetime
  };

  // Create canonical request - headers must be sorted alphabetically
  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map(key => `${key.toLowerCase()}:${headers[key].trim()}`)
    .join('\n');
  
  const signedHeaders = sortedHeaderKeys.map(k => k.toLowerCase()).join(';');
  
  // Canonical URI - must be normalized
  let canonicalUri = parsedUrl.pathname;
  if (!canonicalUri.startsWith('/')) {
    canonicalUri = '/' + canonicalUri;
  }
  
  // Canonical query string (empty for POST)
  const canonicalQueryString = '';
  
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders + '\n',
    signedHeaders,
    bodyHash
  ].join('\n');

  console.log('Canonical Request:\n', canonicalRequest);

  // Create string to sign
  const credentialScope = `${date}/${CONFIG.AWS_REGION}/${service}/aws4_request`;
  const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    datetime,
    credentialScope,
    hashedCanonicalRequest
  ].join('\n');

  console.log('String to Sign:\n', stringToSign);

  // Calculate signature
  const kDate = crypto.createHmac('sha256', 'AWS4' + CONFIG.AWS_SECRET_ACCESS_KEY).update(date).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(CONFIG.AWS_REGION).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  // Create authorization header
  headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${CONFIG.AWS_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  console.log('Authorization:', headers['authorization']);

  return headers;
}

/**
 * Make an HTTPS request with AWS Sigv4 signing
 */
function makeSignedRequest(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = signRequest(method, url, bodyStr);
    headers['content-length'] = Buffer.byteLength(bodyStr);

    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Make a streaming request to OpenAI
 */
function streamOpenAI(messages, onChunk) {
  return new Promise((resolve, reject) => {
    console.log('Starting OpenAI streaming request...');
    console.log('Using API key:', CONFIG.OPENAI_API_KEY ? CONFIG.OPENAI_API_KEY.substring(0, 20) + '...' : 'NOT SET');
    
    const postData = JSON.stringify({
      model: 'gpt-4o',
      messages: messages,
      stream: true
    });

    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      console.log('OpenAI response status:', res.statusCode);
      
      // Handle non-200 responses
      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', chunk => errorData += chunk.toString());
        res.on('end', () => {
          console.error('OpenAI error response:', errorData);
          reject(new Error(`OpenAI API error: ${res.statusCode} - ${errorData}`));
        });
        return;
      }
      
      let buffer = '';
      let fullContent = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                fullContent += content;
                onChunk(content);
              }
            } catch (e) {
              console.error('Parse error for line:', line, e.message);
            }
          }
        }
      });

      res.on('end', () => {
        console.log('OpenAI stream ended, total content length:', fullContent.length);
        resolve(fullContent);
      });
    });

    req.on('error', (error) => {
      console.error('OpenAI request error:', error.message);
      reject(error);
    });
    
    req.write(postData);
    req.end();
  });
}

/**
 * Generate embeddings using OpenAI
 */
async function generateEmbedding(text) {
  const postData = JSON.stringify({
    model: 'text-embedding-3-small',
    input: text,
    dimensions: 1024  // Match your index dimensions
  });

  const options = {
    hostname: 'api.openai.com',
    port: 443,
    path: '/v1/embeddings',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.data?.[0]?.embedding) {
            resolve(response.data[0].embedding);
          } else {
            console.error('Embedding error:', data);
            reject(new Error('Failed to generate embedding'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Decompose query into sub-queries using OpenAI
 */
async function decomposeQuery(query) {
  const postData = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'You are a regulatory expert. Break down the user query into 2-4 focused sub-queries for searching regulatory documents. Return a JSON array with objects containing "query" and "intent" fields.'
      },
      {
        role: 'user',
        content: `Break down this question into focused sub-queries: "${query}"\n\nReturn JSON format: {"subQueries": [{"query": "...", "intent": "..."}]}`
      }
    ],
    response_format: { type: 'json_object' }
  });

  const options = {
    hostname: 'api.openai.com',
    port: 443,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          const content = response.choices?.[0]?.message?.content;
          if (content) {
            const parsed = JSON.parse(content);
            resolve(parsed.subQueries || [{ query: query, intent: 'main query' }]);
          } else {
            resolve([{ query: query, intent: 'main query' }]);
          }
        } catch (e) {
          resolve([{ query: query, intent: 'main query' }]);
        }
      });
    });
    req.on('error', () => resolve([{ query: query, intent: 'main query' }]));
    req.write(postData);
    req.end();
  });
}

/**
 * Search OpenSearch Serverless with hybrid search (vector + keyword)
 */
async function searchDocuments(query, embedding, size = 10) {
  const searchUrl = `${CONFIG.OPENSEARCH_ENDPOINT}/${CONFIG.OPENSEARCH_INDEX}/_search`;
  
  const searchBody = {
    size: size * 3,  // Get more for deduplication
    query: {
      bool: {
        should: [
          // Vector search (semantic) using knn
          {
            knn: {
              contextualized_embedding: {
                vector: embedding,
                k: size * 5
              }
            }
          },
          // BM25 search (keyword)
          {
            multi_match: {
              query: query,
              fields: ['contextualized_text^2', 'title^1.5', 'original_text'],
              boost: 0.3
            }
          }
        ]
      }
    },
    _source: {
      excludes: ['contextualized_embedding']
    }
  };

  try {
    console.log('Searching OpenSearch:', searchUrl);
    const response = await makeSignedRequest('POST', searchUrl, searchBody);
    
    console.log('OpenSearch response status:', response.status);
    
    if (response.status !== 200) {
      console.error('OpenSearch error:', response.status, JSON.stringify(response.data, null, 2));
      return [];
    }

    const hits = response.data.hits?.hits || [];
    console.log('OpenSearch hits:', hits.length);
    
    return hits.map((hit, index) => ({
      id: hit._id,
      title: hit._source.title || hit._source.full_name || hit._source.section_title || 'Untitled',
      code: hit._source.code || '',
      sourceType: hit._source.source_type || 'doc',
      ichType: hit._source.ich_type || '',
      snippet: (hit._source.original_text || '').substring(0, 200) + '...',
      fullText: hit._source.original_text || hit._source.contextualized_text || '',
      relevanceScore: hit._score || 0,
      pageNumbers: hit._source.page_citation || '',
      sourceUrl: hit._source.source_url || '',
      headerPath: hit._source.header_path || ''
    }));
  } catch (error) {
    console.error('Search error:', error.message);
    return [];
  }
}

/**
 * Main search handler
 */
async function handleRegulatorySearch(req, res) {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Parse request body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const { query } = JSON.parse(body);

    if (!query) {
      send({ type: 'error', message: 'Query is required' });
      res.end();
      return;
    }

    console.log('Regulatory search query:', query);

    // Step 1: Analyzing query
    send({ type: 'step', step: 'analyze', status: 'active' });
    await new Promise(r => setTimeout(r, 300));
    send({ type: 'step', step: 'analyze', status: 'complete' });

    // Step 2: Decompose query
    send({ type: 'step', step: 'decompose', status: 'active' });
    const subQueries = await decomposeQuery(query);
    const subQueriesWithIds = subQueries.map((sq, i) => ({
      id: `sq-${i}`,
      query: sq.query,
      intent: sq.intent,
      status: 'pending'
    }));
    send({ type: 'subQueries', subQueries: subQueriesWithIds });
    send({ type: 'step', step: 'decompose', status: 'complete' });

    // Step 3: Search & Rerank
    send({ type: 'step', step: 'search', status: 'active' });
    
    let allSources = [];
    for (const sq of subQueriesWithIds) {
      send({ type: 'subQueryStatus', id: sq.id, status: 'searching' });
      
      try {
        // Generate embedding for the sub-query
        const embedding = await generateEmbedding(sq.query);
        
        // Search OpenSearch
        const results = await searchDocuments(sq.query, embedding, 5);
        
        allSources = allSources.concat(results);
        send({ type: 'subQueryStatus', id: sq.id, status: 'complete', resultCount: results.length });
      } catch (error) {
        console.error('Sub-query search error:', error);
        send({ type: 'subQueryStatus', id: sq.id, status: 'complete', resultCount: 0 });
      }
    }

    // Deduplicate sources by ID
    const uniqueSourcesMap = new Map();
    for (const source of allSources) {
      if (!uniqueSourcesMap.has(source.id) || source.relevanceScore > uniqueSourcesMap.get(source.id).relevanceScore) {
        uniqueSourcesMap.set(source.id, source);
      }
    }
    const uniqueSources = Array.from(uniqueSourcesMap.values());
    
    // Sort by relevance
    uniqueSources.sort((a, b) => b.relevanceScore - a.relevanceScore);
    
    const topSources = uniqueSources.slice(0, 8);
    send({ type: 'sources', sources: topSources });
    send({ type: 'step', step: 'search', status: 'complete' });

    // Step 4: Synthesize answer
    send({ type: 'step', step: 'synthesize', status: 'active' });

    if (topSources.length === 0) {
      send({ type: 'answerChunk', text: 'No relevant documents found for your query. Please try rephrasing your question.' });
      send({ type: 'step', step: 'synthesize', status: 'complete' });
      send({ type: 'done' });
      res.end();
      return;
    }

    // Build context from sources
    const sourcesContext = topSources.slice(0, 5).map((s, i) => 
      `[${i + 1}] ${s.title} (${s.code})\n${s.fullText}`
    ).join('\n\n');

    const messages = [
      {
        role: 'system',
        content: 'You are a regulatory expert specializing in pharmaceutical and medical device regulations. Provide accurate, well-cited answers based on the provided sources. Use citations like [1], [2] to reference sources. Be concise but comprehensive. Format your response with clear paragraphs.'
      },
      {
        role: 'user',
        content: `Answer this regulatory question using the provided sources:\n\nQuestion: ${query}\n\nSources:\n${sourcesContext}\n\nProvide a well-structured answer with citations to the numbered sources.`
      }
    ];

    // Stream the answer
    await streamOpenAI(messages, (chunk) => {
      send({ type: 'answerChunk', text: chunk });
    });

    send({ type: 'step', step: 'synthesize', status: 'complete' });
    send({ type: 'done' });

  } catch (error) {
    console.error('Regulatory search error:', error);
    send({ type: 'error', message: error.message || 'Search failed' });
  }

  res.end();
}

/**
 * CORS preflight handler
 */
function handleCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return true;
  }
  return false;
}

module.exports = {
  handleRegulatorySearch,
  handleCors,
  CONFIG
};
