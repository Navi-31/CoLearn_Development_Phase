'use strict';

const https = require('https');
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const requireAuth = require('../middleware/requireAuth');
const { chatWithOpenRouter } = require('../services/openRouterService');

const aiStrokeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many handwriting requests. Please wait.' },
});

const aiChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many AI requests. Please wait.' },
});

/**
 * Recognizes handwritten strokes using Google Input Tools Handwriting API.
 * Accepts real stroke coordinate arrays [[ [x...], [y...], [t...] ], ...] without hardcoded results.
 */
function queryHandwritingAPI(ink, width, height, language = 'en') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      options: 'enable_pre_space',
      requests: [
        {
          writing_guide: {
            writing_area_width: Math.max(100, Math.round(width || 1600)),
            writing_area_height: Math.max(100, Math.round(height || 1200))
          },
          ink: ink,
          language: language || 'en'
        }
      ]
    });

    const options = {
      hostname: 'inputtools.google.com',
      port: 443,
      path: '/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 8000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Handwriting API returned HTTP ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed) && parsed[0] === 'SUCCESS' && Array.isArray(parsed[1]) && parsed[1][0] && Array.isArray(parsed[1][0][1])) {
            resolve(parsed[1][0][1]);
          } else {
            resolve([]);
          }
        } catch (err) {
          reject(new Error(`Failed to parse recognition response: ${err.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Handwriting recognition request timed out.'));
    });

    req.on('error', (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

/**
 * POST /api/ai/recognize-strokes
 * Receives current whiteboard stroke coordinates and returns handwriting recognition candidates.
 */
router.post('/ai/recognize-strokes', aiStrokeLimiter, requireAuth, async (req, res) => {
  const { ink, width, height, language } = req.body;

  if (!ink || !Array.isArray(ink) || ink.length === 0 || !Array.isArray(ink[0])) {
    return res.status(400).json({
      success: false,
      error: 'Ink strokes array is required and must contain stroke coordinates.'
    });
  }

  try {
    const candidates = await queryHandwritingAPI(ink, width, height, language);
    return res.json({
      success: true,
      candidates: candidates || []
    });
  } catch (err) {
    console.error('[AI Route] Error in handwriting stroke recognition:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * POST /api/ai/chat
 * Proxies messages payload to OpenRouter.
 * Requires Firebase authentication.
 */
router.post('/ai/chat', aiChatLimiter, requireAuth, async (req, res) => {
  const { messages, model } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Messages array is required and cannot be empty.'
    });
  }

  try {
    const aiReply = await chatWithOpenRouter(messages, model);
    return res.json({
      success: true,
      message: aiReply
    });
  } catch (err) {
    console.error('[AI Route] Error processing chat completions:', err.message);
    
    // Return appropriate status codes
    const isConfigError = err.message.includes('API key is not configured');
    const statusCode = isConfigError ? 501 : 500; // 501 Not Implemented for config error

    return res.status(statusCode).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;
