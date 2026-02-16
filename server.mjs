import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import express from 'express';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 8787);
const defaultModel =
  process.env.LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const apiKey = process.env.GEMINI_API_KEY;
const LIVE_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const genaiWebIndexPath = path.join(__dirname, 'node_modules/@google/genai/dist/web/index.mjs');
const pRetryIndexPath = path.join(__dirname, 'node_modules/p-retry/index.js');

if (!apiKey) {
  console.warn('GEMINI_API_KEY is not set. /api/token will fail until configured.');
}

const ai = apiKey
  ? new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: 'v1alpha' },
    })
  : null;

const liveModelCache = {
  updatedAt: 0,
  models: [],
  recommendedModel: defaultModel,
};

const webModuleCache = {
  genaiPatched: null,
  pRetryPatched: null,
};

function stripModelPrefix(modelName) {
  return String(modelName || '').replace(/^models\//, '');
}

async function getLiveModels() {
  if (!ai) {
    return { models: [], recommendedModel: defaultModel };
  }

  const now = Date.now();
  if (
    liveModelCache.models.length > 0 &&
    now - liveModelCache.updatedAt < LIVE_MODEL_CACHE_TTL_MS
  ) {
    return {
      models: [...liveModelCache.models],
      recommendedModel: liveModelCache.recommendedModel,
    };
  }

  const modelNames = [];
  const pager = await ai.models.list({ config: { pageSize: 200 } });
  for await (const model of pager) {
    const methods = model.supportedActions || model.supportedGenerationMethods || [];
    const supportsBidi = methods.some((item) =>
      String(item).toLowerCase().includes('bidigeneratecontent'),
    );
    if (!supportsBidi) {
      continue;
    }
    modelNames.push(stripModelPrefix(model.name));
  }

  modelNames.sort((a, b) => a.localeCompare(b));

  const exactPreferred = modelNames.find(
    (name) => name === 'gemini-2.5-flash-native-audio-preview-12-2025',
  );
  const nativeLatest = modelNames.find((name) => name === 'gemini-2.5-flash-native-audio-latest');
  const nativeAny = modelNames.find((name) => name.toLowerCase().includes('native-audio'));
  const recommendedModel = exactPreferred || nativeLatest || nativeAny || modelNames[0] || defaultModel;

  liveModelCache.updatedAt = now;
  liveModelCache.models = modelNames;
  liveModelCache.recommendedModel = recommendedModel;

  return { models: [...modelNames], recommendedModel };
}

app.use(express.json({ limit: '1mb' }));

app.get('/genai/index.patched.mjs', async (_req, res) => {
  try {
    if (!webModuleCache.genaiPatched) {
      const source = await readFile(genaiWebIndexPath, 'utf8');
      webModuleCache.genaiPatched = source.replace(
        "from 'p-retry';",
        "from '/vendor/p-retry/index.patched.js';",
      );
    }
    res.type('application/javascript').send(webModuleCache.genaiPatched);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown module patch error';
    res.status(500).type('text/plain').send(`Failed to load patched genai module: ${message}`);
  }
});

app.get('/vendor/p-retry/index.patched.js', async (_req, res) => {
  try {
    if (!webModuleCache.pRetryPatched) {
      const source = await readFile(pRetryIndexPath, 'utf8');
      webModuleCache.pRetryPatched = source.replace(
        "from 'is-network-error';",
        "from '/vendor/is-network-error/index.js';",
      );
    }
    res.type('application/javascript').send(webModuleCache.pRetryPatched);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown module patch error';
    res.status(500).type('text/plain').send(`Failed to load patched p-retry module: ${message}`);
  }
});

app.use('/genai', express.static(path.join(__dirname, 'node_modules/@google/genai/dist/web')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

app.get('/api/config', (_req, res) => {
  res.json({
    hasApiKey: Boolean(apiKey),
    defaultModel,
  });
});

app.get('/api/live-models', async (_req, res) => {
  try {
    const payload = await getLiveModels();
    res.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown model lookup error';
    console.error('Failed listing live models:', message);
    res.status(500).json({
      error: `Failed to list live models: ${message}`,
      models: [],
      recommendedModel: defaultModel,
    });
  }
});

app.get('/api/token', async (req, res) => {
  if (!ai) {
    res.status(500).json({
      error:
        'Missing GEMINI_API_KEY on server. Add it to .env and restart the demo server.',
    });
    return;
  }

  const model =
    typeof req.query.model === 'string' && req.query.model.trim().length > 0
      ? req.query.model.trim()
      : defaultModel;

  const now = Date.now();
  const expiresAt = new Date(now + 30 * 60 * 1000).toISOString();
  const newSessionExpiresAt = new Date(now + 90 * 1000).toISOString();

  try {
    const token = await ai.authTokens.create({
      config: {
        uses: 2,
        expireTime: expiresAt,
        newSessionExpireTime: newSessionExpiresAt,
        liveConnectConstraints: {
          model,
          config: {
            responseModalities: ['AUDIO'],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        },
      },
    });

    if (!token.name) {
      throw new Error('Token response did not include token name.');
    }

    res.json({
      token: token.name,
      model,
      expiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown token error';
    console.error('Failed creating ephemeral token:', message);
    res.status(500).json({
      error: `Failed to create auth token: ${message}`,
    });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(port, () => {
  console.log(`Gemini Live home scan demo running on http://localhost:${port}`);
});
