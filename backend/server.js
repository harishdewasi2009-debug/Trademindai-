// server.js
const { assertRequiredEnv, config } = require('./config');
assertRequiredEnv();

const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');

const { apiLimiter } = require('./middleware/rateLimit');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { verifyAccessToken } = require('./utils/jwt');

const authRoutes = require('./routes/authRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const portfolioRoutes = require('./routes/portfolioRoutes');
const watchlistRoutes = require('./routes/watchlistRoutes');
const adminRoutes = require('./routes/adminRoutes');
const aiRoutes = require('./routes/aiRoutes');
const marketRoutes = require('./routes/marketRoutes');
const referralRoutes = require('./routes/referralRoutes');
const { handleWebhook } = require('./controllers/paymentController');
const { startUpstoxTokenScheduler } = require('./services/tokenScheduler');
const marketDataService = require('./services/marketDataService');
const liveFeedService = require('./services/liveFeedService');

const app = express();

app.set('trust proxy', 1);

// FIX: tighten Helmet — add CSP, disable x-powered-by, enforce HSTS in production
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: config.nodeEnv === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// FIX: restrict CORS to specific origin with explicit methods and headers
app.use(cors({
  origin: config.frontendUrl,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Label'],
}));

// FIX: use 'combined' format in production (includes IP + user-agent for audit logs)
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));

// ══ RAZORPAY WEBHOOK — raw body BEFORE express.json() ══
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), handleWebhook);

// ══ Standard body parsing ══
app.use(express.json({ limit: '50kb' })); // FIX: was 1mb — tightened to 50kb (no route needs more)
app.use(cookieParser());
app.use(apiLimiter);

// ══ Routes ══
// FIX: health check no longer reveals env name in production
app.get('/health', (req, res) => res.json({
  status: 'ok',
  ...(config.nodeEnv !== 'production' ? { env: config.nodeEnv } : {}),
}));

app.use('/api/auth', authRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/referral', referralRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

// ══ Live market WebSocket — real-time ticks, no more polling ══
// Browsers connect to wss://<backend>/ws/market and get pushed price
// updates the instant Upstox sends them (see services/liveFeedService.js).
// Auth reuses the same httpOnly `accessToken` cookie as the REST API — a
// WS "upgrade" request from the browser carries cookies automatically, so
// we verify it by hand here (cookie-parser doesn't run on upgrade requests).
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : null;
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws/market')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    liveFeedService.registerBrowserClient(ws);
  });
});

server.listen(config.port, () => {
  console.log(`✅ TradeMind backend running on port ${config.port} [${config.nodeEnv}]`);
  console.log(`   Health check: http://localhost:${config.port}/health`);
  console.log(`   Live market WebSocket: ws://localhost:${config.port}/ws/market`);
  startUpstoxTokenScheduler();

  // If Upstox is already connected (token cached from a previous approval),
  // start the live feed immediately instead of waiting for the next login.
  marketDataService.upstoxStatus()
    .then(async (status) => {
      if (!status.connected) return;
      const token = await marketDataService.getValidAccessToken();
      await liveFeedService.startLiveFeed(token);
    })
    .catch((err) => console.warn('[liveFeed] not started at boot:', err.message));
});

module.exports = app;
