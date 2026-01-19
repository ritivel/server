/*
 * Regulatory Search Handler
 * 
 * This module provides an AI-powered regulatory document search endpoint with:
 * - Query decomposition using Claude (AWS Bedrock)
 * - Hybrid search (vector + keyword) via OpenSearch Serverless
 * - Streaming responses via Server-Sent Events (SSE)
 * - Claude-generated answers with source citations
 * 
 * Uses AWS Bedrock for all LLM operations (consistent with agents-backend)
 */

'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// Configuration - all secrets must be provided via environment variables
const CONFIG = {
  OPENSEARCH_ENDPOINT: process.env.OPENSEARCH_ENDPOINT || 'https://your-opensearch-endpoint.aoss.amazonaws.com',
  OPENSEARCH_INDEX: process.env.OPENSEARCH_INDEX || 'regulatory-chunks',
  AWS_REGION: process.env.AWS_REGION || 'us-east-1',
  // Claude model via Bedrock (consistent with agents-backend)
  CLAUDE_MODEL: process.env.CLAUDE_MODEL || 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY
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
 * Make a streaming request to Claude via AWS Bedrock
 * Uses the converse-stream API for streaming responses
 */
function streamClaude(messages, onChunk) {
  return new Promise((resolve, reject) => {
    console.log('Starting Claude (Bedrock) streaming request...');
    console.log('Using model:', CONFIG.CLAUDE_MODEL);
    
    const host = `bedrock-runtime.${CONFIG.AWS_REGION}.amazonaws.com`;
    const modelId = CONFIG.CLAUDE_MODEL;
    const encodedModelId = encodeURIComponent(modelId);
    const requestPath = `/model/${encodedModelId}/converse-stream`;
    
    // Convert messages to Bedrock converse format
    const bedrockMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: [{ text: m.content }]
      }));
    
    // Extract system message if present
    const systemMessage = messages.find(m => m.role === 'system');
    
    const body = JSON.stringify({
      modelId: modelId,
      messages: bedrockMessages,
      system: systemMessage ? [{ text: systemMessage.content }] : undefined,
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0.3
      }
    });

    // Sign the request
    const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = datetime.substring(0, 8);
    const service = 'bedrock';
    
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    
    const headers = {
      'content-type': 'application/json',
      'host': host,
      'x-amz-content-sha256': bodyHash,
      'x-amz-date': datetime
    };

    // Create canonical request
    const sortedHeaderKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedHeaderKeys
      .map(key => `${key.toLowerCase()}:${headers[key].trim()}`)
      .join('\n');
    const signedHeaders = sortedHeaderKeys.map(k => k.toLowerCase()).join(';');
    
    // Double URL-encode the path for signing
    const canonicalPath = `/model/${encodeURIComponent(encodedModelId)}/converse-stream`;
    
    const canonicalRequest = [
      'POST',
      canonicalPath,
      '',
      canonicalHeaders + '\n',
      signedHeaders,
      bodyHash
    ].join('\n');

    // Create string to sign
    const credentialScope = `${date}/${CONFIG.AWS_REGION}/${service}/aws4_request`;
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      datetime,
      credentialScope,
      hashedCanonicalRequest
    ].join('\n');

    // Calculate signature
    const kDate = crypto.createHmac('sha256', 'AWS4' + CONFIG.AWS_SECRET_ACCESS_KEY).update(date).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(CONFIG.AWS_REGION).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${CONFIG.AWS_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    headers['content-length'] = Buffer.byteLength(body);

    const options = {
      hostname: host,
      port: 443,
      path: requestPath,
      method: 'POST',
      headers: headers
    };

    const req = https.request(options, (res) => {
      console.log('Claude (Bedrock) response status:', res.statusCode);
      
      // Handle non-200 responses
      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', chunk => errorData += chunk.toString());
        res.on('end', () => {
          console.error('Claude (Bedrock) error response:', errorData);
          reject(new Error(`Claude API error: ${res.statusCode} - ${errorData}`));
        });
        return;
      }
      
      let buffer = Buffer.alloc(0);
      let fullContent = '';

      res.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        
        // Parse Bedrock event stream format
        // Events are prefixed with headers indicating message type and length
        while (buffer.length > 0) {
          // Check if we have enough bytes for the prelude (12 bytes)
          if (buffer.length < 12) break;
          
          // Read total byte length from first 4 bytes (big endian)
          const totalLength = buffer.readUInt32BE(0);
          
          // Check if we have the complete message
          if (buffer.length < totalLength) break;
          
          // Extract the message
          const message = buffer.slice(0, totalLength);
          buffer = buffer.slice(totalLength);
          
          // Parse the event stream message
          try {
            // Skip prelude (12 bytes) and read headers
            let offset = 12;
            const headersLength = message.readUInt32BE(4);
            const headersEnd = 12 + headersLength;
            
            // Parse headers to find content-type
            let eventType = '';
            let headerOffset = offset;
            while (headerOffset < headersEnd) {
              const nameLength = message.readUInt8(headerOffset);
              headerOffset += 1;
              const name = message.slice(headerOffset, headerOffset + nameLength).toString('utf8');
              headerOffset += nameLength;
              const valueType = message.readUInt8(headerOffset);
              headerOffset += 1;
              
              if (valueType === 7) { // String type
                const valueLength = message.readUInt16BE(headerOffset);
                headerOffset += 2;
                const value = message.slice(headerOffset, headerOffset + valueLength).toString('utf8');
                headerOffset += valueLength;
                
                if (name === ':event-type') {
                  eventType = value;
                }
              } else {
                // Skip other value types
                break;
              }
            }
            
            // Extract payload (after headers, before trailing CRC)
            const payloadStart = headersEnd;
            const payloadEnd = totalLength - 4; // Subtract message CRC
            const payload = message.slice(payloadStart, payloadEnd);
            
            if (payload.length > 0) {
              try {
                const event = JSON.parse(payload.toString('utf8'));
                
                // Handle content block delta
                if (event.contentBlockDelta && event.contentBlockDelta.delta && event.contentBlockDelta.delta.text) {
                  const text = event.contentBlockDelta.delta.text;
                  fullContent += text;
                  onChunk(text);
                }
              } catch (e) {
                // Not JSON or parse error, skip
              }
            }
          } catch (e) {
            console.error('Event stream parse error:', e.message);
          }
        }
      });

      res.on('end', () => {
        console.log('Claude stream ended, total content length:', fullContent.length);
        resolve(fullContent);
      });
    });

    req.on('error', (error) => {
      console.error('Claude (Bedrock) request error:', error.message);
      reject(error);
    });
    
    req.write(body);
    req.end();
  });
}

/**
 * Generate embeddings using AWS Bedrock Titan
 */
async function generateEmbedding(text) {
  const modelId = 'amazon.titan-embed-text-v2:0';
  const host = `bedrock-runtime.${CONFIG.AWS_REGION}.amazonaws.com`;
  // URL-encode the model ID for the HTTP request path
  const encodedModelId = encodeURIComponent(modelId);
  const requestPath = `/model/${encodedModelId}/invoke`;
  // For canonical request, AWS requires double URL-encoding of special chars
  const canonicalPath = `/model/${encodeURIComponent(encodedModelId)}/invoke`;
  
  const body = JSON.stringify({
    inputText: text,
    dimensions: 1024,  // Match your index dimensions
    normalize: true
  });

  return new Promise((resolve, reject) => {
    const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = datetime.substring(0, 8);
    const service = 'bedrock';
    
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    
    const headers = {
      'content-type': 'application/json',
      'host': host,
      'x-amz-content-sha256': bodyHash,
      'x-amz-date': datetime
    };

    // Create canonical request - path must be double URI-encoded for signing
    const sortedHeaderKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedHeaderKeys
      .map(key => `${key.toLowerCase()}:${headers[key].trim()}`)
      .join('\n');
    const signedHeaders = sortedHeaderKeys.map(k => k.toLowerCase()).join(';');
    
    const canonicalRequest = [
      'POST',
      canonicalPath,  // Double URI-encoded for signing
      '',    // Empty query string
      canonicalHeaders + '\n',
      signedHeaders,
      bodyHash
    ].join('\n');

    // Create string to sign
    const credentialScope = `${date}/${CONFIG.AWS_REGION}/${service}/aws4_request`;
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      datetime,
      credentialScope,
      hashedCanonicalRequest
    ].join('\n');

    // Calculate signature
    const kDate = crypto.createHmac('sha256', 'AWS4' + CONFIG.AWS_SECRET_ACCESS_KEY).update(date).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(CONFIG.AWS_REGION).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${CONFIG.AWS_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    headers['content-length'] = Buffer.byteLength(body);

    const options = {
      hostname: host,
      port: 443,
      path: requestPath,  // Single-encoded for actual HTTP request
      method: 'POST',
      headers: headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.embedding) {
            resolve(response.embedding);
          } else {
            console.error('Titan Embedding error:', data);
            reject(new Error('Failed to generate Titan embedding'));
          }
        } catch (e) {
          console.error('Titan Embedding parse error:', e, data);
          reject(e);
        }
      });
    });
    req.on('error', (e) => {
      console.error('Titan Embedding request error:', e);
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Decompose query into sub-queries using Claude via Bedrock
 */
async function decomposeQuery(query) {
  const host = `bedrock-runtime.${CONFIG.AWS_REGION}.amazonaws.com`;
  const modelId = CONFIG.CLAUDE_MODEL;
  const encodedModelId = encodeURIComponent(modelId);
  const requestPath = `/model/${encodedModelId}/converse`;
  
  const body = JSON.stringify({
    modelId: modelId,
    messages: [
      {
        role: 'user',
        content: [{ text: `You are a regulatory expert. Break down this query into 2-4 focused sub-queries for searching regulatory documents.

Query: "${query}"

Return ONLY a JSON object in this exact format (no other text):
{"subQueries": [{"query": "...", "intent": "..."}]}` }]
      }
    ],
    system: [{ text: 'You are a regulatory expert. Always respond with valid JSON only, no markdown or other formatting.' }],
    inferenceConfig: {
      maxTokens: 1024,
      temperature: 0.2
    }
  });

  return new Promise((resolve, reject) => {
    // Sign the request
    const datetime = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = datetime.substring(0, 8);
    const service = 'bedrock';
    
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    
    const headers = {
      'content-type': 'application/json',
      'host': host,
      'x-amz-content-sha256': bodyHash,
      'x-amz-date': datetime
    };

    const sortedHeaderKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedHeaderKeys
      .map(key => `${key.toLowerCase()}:${headers[key].trim()}`)
      .join('\n');
    const signedHeaders = sortedHeaderKeys.map(k => k.toLowerCase()).join(';');
    
    const canonicalPath = `/model/${encodeURIComponent(encodedModelId)}/converse`;
    
    const canonicalRequest = [
      'POST',
      canonicalPath,
      '',
      canonicalHeaders + '\n',
      signedHeaders,
      bodyHash
    ].join('\n');

    const credentialScope = `${date}/${CONFIG.AWS_REGION}/${service}/aws4_request`;
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      datetime,
      credentialScope,
      hashedCanonicalRequest
    ].join('\n');

    const kDate = crypto.createHmac('sha256', 'AWS4' + CONFIG.AWS_SECRET_ACCESS_KEY).update(date).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(CONFIG.AWS_REGION).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${CONFIG.AWS_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    headers['content-length'] = Buffer.byteLength(body);

    const options = {
      hostname: host,
      port: 443,
      path: requestPath,
      method: 'POST',
      headers: headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          // Extract text from Bedrock converse response
          const content = response.output?.message?.content?.[0]?.text;
          if (content) {
            // Try to extract JSON from the response (handle markdown code blocks)
            let jsonStr = content;
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              jsonStr = jsonMatch[0];
            }
            const parsed = JSON.parse(jsonStr);
            resolve(parsed.subQueries || [{ query: query, intent: 'main query' }]);
          } else {
            console.log('No content in decompose response:', data);
            resolve([{ query: query, intent: 'main query' }]);
          }
        } catch (e) {
          console.error('Decompose query parse error:', e.message);
          resolve([{ query: query, intent: 'main query' }]);
        }
      });
    });
    req.on('error', (e) => {
      console.error('Decompose query request error:', e.message);
      resolve([{ query: query, intent: 'main query' }]);
    });
    req.write(body);
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
 * 
 * Supports two modes:
 * - sources_only: true  - Returns only sources (for agents-backend to synthesize with Claude)
 * - sources_only: false - Full flow with Claude synthesis (legacy/direct frontend calls)
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
    const { query, sources_only } = JSON.parse(body);

    if (!query) {
      send({ type: 'error', message: 'Query is required' });
      res.end();
      return;
    }

    console.log('Regulatory search query:', query, 'sources_only:', sources_only);

    // Step 1: Analyzing query
    send({ type: 'step', step: 'analyze', status: 'active' });
    await new Promise(r => setTimeout(r, 100));
    send({ type: 'step', step: 'analyze', status: 'complete' });

    // Step 2: Decompose query (skip in sources_only mode for speed)
    let subQueriesWithIds;
    if (sources_only) {
      // In sources_only mode, just use the main query
      subQueriesWithIds = [{ id: 'sq-0', query: query, intent: 'main query', status: 'pending' }];
    } else {
      send({ type: 'step', step: 'decompose', status: 'active' });
      const subQueries = await decomposeQuery(query);
      subQueriesWithIds = subQueries.map((sq, i) => ({
        id: `sq-${i}`,
        query: sq.query,
        intent: sq.intent,
        status: 'pending'
      }));
      send({ type: 'subQueries', subQueries: subQueriesWithIds });
      send({ type: 'step', step: 'decompose', status: 'complete' });
    }

    // Step 3: Search & Rerank
    send({ type: 'step', step: 'search', status: 'active' });
    
    let allSources = [];
    for (const sq of subQueriesWithIds) {
      if (!sources_only) {
        send({ type: 'subQueryStatus', id: sq.id, status: 'searching' });
      }
      
      try {
        // Generate embedding for the sub-query
        const embedding = await generateEmbedding(sq.query);
        
        // Search OpenSearch
        const results = await searchDocuments(sq.query, embedding, sources_only ? 10 : 5);
        
        allSources = allSources.concat(results);
        if (!sources_only) {
          send({ type: 'subQueryStatus', id: sq.id, status: 'complete', resultCount: results.length });
        }
      } catch (error) {
        console.error('Sub-query search error:', error);
        if (!sources_only) {
          send({ type: 'subQueryStatus', id: sq.id, status: 'complete', resultCount: 0 });
        }
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

    // In sources_only mode, we're done - agents-backend will synthesize
    if (sources_only) {
      send({ type: 'done' });
      res.end();
      return;
    }

    // Step 4: Synthesize answer (only in full mode)
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

    // Stream the answer using Claude
    await streamClaude(messages, (chunk) => {
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
