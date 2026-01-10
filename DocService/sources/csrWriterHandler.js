/*
 * CSR Writer Handler
 * 
 * This module proxies API requests to the Python CSR Agent FastAPI server:
 * - POST /api/csr-writer/index - Proxy file uploads for indexing
 * - POST /api/csr-writer/query - Proxy queries and stream SSE responses
 * - GET /api/csr-writer/status/:sessionId - Proxy session status requests
 * - DELETE /api/csr-writer/session/:sessionId - Proxy session deletion
 * 
 * Phase 7: Real Python Agent Proxy Connection
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

// Configuration
const CONFIG = {
  // CSR Agent URL - can be set via environment variable
  // Default to the ngrok URL or localhost
  AGENT_URL: process.env.CSR_AGENT_URL || 'https://isanthous-breccial-claire.ngrok-free.dev',
  // Timeout for index requests (indexing can take several minutes)
  INDEX_TIMEOUT: 600000, // 10 minutes
  // Timeout for query requests (increased for long-running queries)
  QUERY_TIMEOUT: 300000, // 5 minutes
  // Timeout for status/delete requests
  DEFAULT_TIMEOUT: 30000, // 30 seconds
  // Max file size in bytes (50MB)
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  // Allowed file extensions
  ALLOWED_EXTENSIONS: ['.pdf', '.docx', '.md', '.mmd']
};

// In-memory session storage for caching session-to-csr_id mapping
const sessionCache = new Map();

/**
 * Get the appropriate http/https module based on URL
 */
function getHttpModule(url) {
  return url.startsWith('https') ? https : http;
}

/**
 * Parse URL and return options for http request
 */
function parseUrl(urlString) {
  const url = new URL(urlString);
  return {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    protocol: url.protocol
  };
}

/**
 * CORS preflight handler
 */
function handleCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return true;
  }
  return false;
}

/**
 * Collect request body as Buffer
 */
async function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * POST /api/csr-writer/index
 * Proxy file uploads to Python CSR Agent for indexing
 */
async function handleIndex(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  console.log('CSR Writer Proxy: Index request received');
  console.log('CSR Writer Proxy: Forwarding to:', CONFIG.AGENT_URL + '/api/csr-writer/index');
  
  try {
    // Collect the entire request body
    const body = await collectBody(req);
    console.log('CSR Writer Proxy: Received body size:', body.length);
    
    // Parse the target URL
    const targetUrl = CONFIG.AGENT_URL + '/api/csr-writer/index';
    const urlParts = parseUrl(targetUrl);
    const httpModule = getHttpModule(CONFIG.AGENT_URL);
    
    // Forward the request to the Python agent
    const proxyReq = httpModule.request({
      hostname: urlParts.hostname,
      port: urlParts.port,
      path: '/api/csr-writer/index',
      method: 'POST',
      headers: {
        'Content-Type': req.headers['content-type'],
        'Content-Length': body.length,
        // Skip ngrok browser warning
        'ngrok-skip-browser-warning': 'true'
      },
      timeout: CONFIG.INDEX_TIMEOUT
    }, (proxyRes) => {
      console.log('CSR Writer Proxy: Index response status:', proxyRes.statusCode);
      
      // Forward response headers
      res.statusCode = proxyRes.statusCode;
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/json');
      
      // Collect and forward response
      let responseData = '';
      proxyRes.on('data', chunk => {
        responseData += chunk;
      });
      
      proxyRes.on('end', () => {
        console.log('CSR Writer Proxy: Index response received, length:', responseData.length);
        
        try {
          // Parse response to cache session info
          const data = JSON.parse(responseData);
          if (data.success && data.sessionId) {
            sessionCache.set(data.sessionId, {
              sessionId: data.sessionId,
              csr_id: data.session?.csr_id || null,
              files: data.files,
              stats: data.stats,
              createdAt: new Date()
            });
            console.log('CSR Writer Proxy: Cached session:', data.sessionId);
          }
        } catch (e) {
          // Ignore parse errors, just forward the response
        }
        
        res.end(responseData);
      });
    });
    
    proxyReq.on('error', (error) => {
      console.error('CSR Writer Proxy: Index error:', error.message);
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: false,
        error: 'CSR Agent is not available: ' + error.message
      }));
    });
    
    proxyReq.on('timeout', () => {
      console.error('CSR Writer Proxy: Index timeout');
      proxyReq.destroy();
      res.statusCode = 504;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: false,
        error: 'CSR Agent request timeout - indexing may take several minutes for large documents'
      }));
    });
    
    // Send the body
    proxyReq.write(body);
    proxyReq.end();
    
  } catch (error) {
    console.error('CSR Writer Proxy: Index error:', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: false,
      error: 'Internal server error: ' + error.message
    }));
  }
}

/**
 * POST /api/csr-writer/query
 * Proxy queries to Python CSR Agent and stream SSE responses
 */
async function handleQuery(req, res) {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  
  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  
  console.log('CSR Writer Proxy: Query request received');
  
  try {
    // Collect and parse the request body
    const bodyBuffer = await collectBody(req);
    const body = JSON.parse(bodyBuffer.toString());
    
    console.log('CSR Writer Proxy: Query:', { sessionId: body.sessionId, query: body.query });
    
    // Validate
    if (!body.sessionId) {
      send({ type: 'error', message: 'Session ID is required' });
      res.end();
      return;
    }
    
    if (!body.query || body.query.trim().length === 0) {
      send({ type: 'error', message: 'Query is required' });
      res.end();
      return;
    }
    
    // Send initial status
    send({ type: 'status', message: 'Connecting to CSR Agent...' });
    
    // Parse the target URL
    const targetUrl = CONFIG.AGENT_URL + '/api/csr-writer/query';
    const urlParts = parseUrl(targetUrl);
    const httpModule = getHttpModule(CONFIG.AGENT_URL);
    
    // Forward the request to the Python agent
    const proxyReq = httpModule.request({
      hostname: urlParts.hostname,
      port: urlParts.port,
      path: '/api/csr-writer/query',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'ngrok-skip-browser-warning': 'true'
      },
      timeout: CONFIG.QUERY_TIMEOUT
    }, (proxyRes) => {
      console.log('CSR Writer Proxy: Query response status:', proxyRes.statusCode);
      
      if (proxyRes.statusCode !== 200) {
        let errorData = '';
        proxyRes.on('data', chunk => errorData += chunk);
        proxyRes.on('end', () => {
          console.error('CSR Writer Proxy: Query error response:', errorData);
          send({ type: 'error', message: 'CSR Agent error: ' + (errorData || proxyRes.statusCode) });
          res.end();
        });
        return;
      }
      
      // Stream the SSE response
      proxyRes.on('data', (chunk) => {
        const text = chunk.toString();
        // Forward SSE data directly
        res.write(text);
      });
      
      proxyRes.on('end', () => {
        console.log('CSR Writer Proxy: Query stream ended');
        res.end();
      });
      
      proxyRes.on('error', (error) => {
        console.error('CSR Writer Proxy: Query stream error:', error);
        send({ type: 'error', message: 'Stream error: ' + error.message });
        res.end();
      });
    });
    
    proxyReq.on('error', (error) => {
      console.error('CSR Writer Proxy: Query connection error:', error.message);
      send({ type: 'error', message: 'CSR Agent is not available: ' + error.message });
      res.end();
    });
    
    proxyReq.on('timeout', () => {
      console.error('CSR Writer Proxy: Query timeout');
      proxyReq.destroy();
      send({ type: 'error', message: 'CSR Agent request timeout' });
      res.end();
    });
    
    // Send the request body
    proxyReq.write(JSON.stringify(body));
    proxyReq.end();
    
  } catch (error) {
    console.error('CSR Writer Proxy: Query error:', error);
    send({ type: 'error', message: 'Internal server error: ' + error.message });
    res.end();
  }
}

/**
 * GET /api/csr-writer/status/:sessionId
 * Proxy session status requests to Python CSR Agent
 */
async function handleStatus(req, res, sessionId) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  
  console.log('CSR Writer Proxy: Status request for session:', sessionId);
  
  try {
    if (!sessionId) {
      res.statusCode = 400;
      res.end(JSON.stringify({
        success: false,
        error: 'Session ID is required'
      }));
      return;
    }
    
    // Parse the target URL
    const targetUrl = CONFIG.AGENT_URL + '/api/csr-writer/status/' + sessionId;
    const urlParts = parseUrl(targetUrl);
    const httpModule = getHttpModule(CONFIG.AGENT_URL);
    
    // Forward the request to the Python agent
    const proxyReq = httpModule.request({
      hostname: urlParts.hostname,
      port: urlParts.port,
      path: '/api/csr-writer/status/' + sessionId,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      },
      timeout: CONFIG.DEFAULT_TIMEOUT
    }, (proxyRes) => {
      console.log('CSR Writer Proxy: Status response status:', proxyRes.statusCode);
      
      res.statusCode = proxyRes.statusCode;
      
      let responseData = '';
      proxyRes.on('data', chunk => responseData += chunk);
      proxyRes.on('end', () => {
        console.log('CSR Writer Proxy: Status response:', responseData.substring(0, 200));
        res.end(responseData);
      });
    });
    
    proxyReq.on('error', (error) => {
      console.error('CSR Writer Proxy: Status error:', error.message);
      res.statusCode = 503;
      res.end(JSON.stringify({
        success: false,
        error: 'CSR Agent is not available: ' + error.message
      }));
    });
    
    proxyReq.on('timeout', () => {
      console.error('CSR Writer Proxy: Status timeout');
      proxyReq.destroy();
      res.statusCode = 504;
      res.end(JSON.stringify({
        success: false,
        error: 'CSR Agent request timeout'
      }));
    });
    
    proxyReq.end();
    
  } catch (error) {
    console.error('CSR Writer Proxy: Status error:', error);
    res.statusCode = 500;
    res.end(JSON.stringify({
      success: false,
      error: 'Internal server error: ' + error.message
    }));
  }
}

/**
 * DELETE /api/csr-writer/session/:sessionId
 * Proxy session deletion requests to Python CSR Agent
 */
async function handleDeleteSession(req, res, sessionId) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  
  console.log('CSR Writer Proxy: Delete session request:', sessionId);
  
  try {
    if (!sessionId) {
      res.statusCode = 400;
      res.end(JSON.stringify({
        success: false,
        error: 'Session ID is required'
      }));
      return;
    }
    
    // Remove from local cache
    sessionCache.delete(sessionId);
    
    // Parse the target URL
    const targetUrl = CONFIG.AGENT_URL + '/api/csr-writer/session/' + sessionId;
    const urlParts = parseUrl(targetUrl);
    const httpModule = getHttpModule(CONFIG.AGENT_URL);
    
    // Forward the request to the Python agent
    const proxyReq = httpModule.request({
      hostname: urlParts.hostname,
      port: urlParts.port,
      path: '/api/csr-writer/session/' + sessionId,
      method: 'DELETE',
      headers: {
        'Accept': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      },
      timeout: CONFIG.DEFAULT_TIMEOUT
    }, (proxyRes) => {
      console.log('CSR Writer Proxy: Delete response status:', proxyRes.statusCode);
      
      res.statusCode = proxyRes.statusCode;
      
      let responseData = '';
      proxyRes.on('data', chunk => responseData += chunk);
      proxyRes.on('end', () => {
        console.log('CSR Writer Proxy: Delete response:', responseData);
        res.end(responseData);
      });
    });
    
    proxyReq.on('error', (error) => {
      console.error('CSR Writer Proxy: Delete error:', error.message);
      res.statusCode = 503;
      res.end(JSON.stringify({
        success: false,
        error: 'CSR Agent is not available: ' + error.message
      }));
    });
    
    proxyReq.on('timeout', () => {
      console.error('CSR Writer Proxy: Delete timeout');
      proxyReq.destroy();
      res.statusCode = 504;
      res.end(JSON.stringify({
        success: false,
        error: 'CSR Agent request timeout'
      }));
    });
    
    proxyReq.end();
    
  } catch (error) {
    console.error('CSR Writer Proxy: Delete error:', error);
    res.statusCode = 500;
    res.end(JSON.stringify({
      success: false,
      error: 'Internal server error: ' + error.message
    }));
  }
}

/**
 * Main router for CSR Writer endpoints
 */
function router(req, res) {
  const url = req.url;
  const method = req.method;
  
  console.log('CSR Writer Proxy Router:', method, url);
  
  // Handle CORS preflight
  if (handleCors(req, res)) {
    return;
  }
  
  // Parse URL to extract path and params
  const urlParts = url.split('?')[0].split('/').filter(p => p);
  
  // Route: POST /api/csr-writer/index
  if (method === 'POST' && url.startsWith('/api/csr-writer/index')) {
    return handleIndex(req, res);
  }
  
  // Route: POST /api/csr-writer/query
  if (method === 'POST' && url.startsWith('/api/csr-writer/query')) {
    return handleQuery(req, res);
  }
  
  // Route: GET /api/csr-writer/status/:sessionId
  if (method === 'GET' && url.startsWith('/api/csr-writer/status/')) {
    const sessionId = urlParts[urlParts.length - 1];
    return handleStatus(req, res, sessionId);
  }
  
  // Route: DELETE /api/csr-writer/session/:sessionId
  if (method === 'DELETE' && url.startsWith('/api/csr-writer/session/')) {
    const sessionId = urlParts[urlParts.length - 1];
    return handleDeleteSession(req, res, sessionId);
  }
  
  // 404 for unknown routes
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    success: false,
    error: 'Endpoint not found'
  }));
}

module.exports = {
  router,
  handleIndex,
  handleQuery,
  handleStatus,
  handleDeleteSession,
  handleCors,
  CONFIG
};
