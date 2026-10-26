// routes/notificationRoutes.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminCheck');
const { notifLimiter } = require('../middleware/rateLimit');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const svc = require('../services/notificationService');

router.use(requireAuth);

// GET /api/notifications?limit=30&before=<iso>&unread=1
router.get('/', asyncHandler(async (req, res) => {
  const [items, unread] = await Promise.all([
    svc.list(req.user.id, { limit: req.query.limit, before: req.query.before, unreadOnly: req.query.unread === '1' }),
    svc.unreadCount(req.user.id),
  ]);
  res.json({ notifications: items, unreadCount: unread });
}));

router.get('/unread-count', notifLimiter, asyncHandler(async (req, res) => {
  res.json({ unreadCount: await svc.unreadCount(req.user.id) });
}));

// POST /api/notifications/read   { ids: [uuid,...] } | { all: true }
router.post('/read', asyncHandler(async (req, res) => {
  await svc.markRead(req.user.id, req.body?.all ? 'all' : req.body?.ids);
  res.json({ ok: true, unreadCount: await svc.unreadCount(req.user.id) });
}));

// GET/PUT /api/notifications/prefs
router.get('/prefs', asyncHandler(async (req, res) => {
  res.json({ prefs: await svc.getPrefs(req.user.id), pushSupported: svc.pushEnabled() });
}));
router.put('/prefs', asyncHandler(async (req, res) => {
  res.json({ prefs: await svc.updatePrefs(req.user.id, req.body || {}) });
}));

// Web Push
router.get('/push/key', (req, res) => {
  if (!svc.pushEnabled()) return res.json({ supported: false });
  res.json({ supported: true, publicKey: svc.vapidPublicKey() });
});
router.post('/push/subscribe', asyncHandler(async (req, res) => {
  if (!svc.pushEnabled()) throw new AppError('Push notifications are not configured on this server.', 501);
  try { await svc.savePushSubscription(req.user.id, req.body?.subscription); }
  catch (e) { throw new AppError(e.message, 400); }
  await svc.updatePrefs(req.user.id, { push: true });
  res.json({ ok: true });
}));
router.post('/push/unsubscribe', asyncHandler(async (req, res) => {
  if (req.body?.endpoint) await svc.removePushSubscription(req.user.id, req.body.endpoint);
  res.json({ ok: true });
}));

// POST /api/notifications/test — sends the caller a sample notification
router.post('/test', asyncHandler(async (req, res) => {
  const n = await svc.notifyUser(req.user.id, {
    type: 'test', category: 'market', severity: 'info',
    title: '✅ Test notification — alerts are working',
    body: 'You will see watchlist, portfolio, screener, sector-heat and top-mover alerts here as they trigger.',
    dedupeKey: `test:${Date.now()}`,
  });
  res.json({ ok: true, notification: n });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await svc.remove(req.user.id, req.params.id === 'all' ? 'all' : req.params.id);
  res.json({ ok: true, unreadCount: await svc.unreadCount(req.user.id) });
}));

// Admin: run the scanners right now (handy to verify after deploy)
router.post('/admin/run', requireAdmin, asyncHandler(async (req, res) => {
  const engine = require('../services/notificationEngine');
  res.json({ personal: await engine.runPersonalScan(), market: await engine.runMarketScan(), screener: await engine.runScreenerScan() });
}));

module.exports = router;
