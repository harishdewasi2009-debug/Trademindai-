// services/tokenScheduler.js
// ══════════════════════════════════════════════════════════════════════════
//  Fully automatic daily trigger for the Upstox token refresh.
//
//  Upstox access tokens expire every day around 3:25am IST — there's no
//  official unattended way around that (see marketDataService.js for the
//  full explanation). What this scheduler automates is the "asking" part:
//
//   08:00 IST daily → calls requestAccessTokenApproval(), which makes
//                     Upstox push an Approve/Reject notification straight
//                     to the admin's phone (Upstox app + WhatsApp). This
//                     runs with NO human needing to trigger it.
//   08:45 IST daily → checks whether the token actually got approved. If
//                     not (missed notification, phone off, etc.), sends a
//                     backup email alert so the admin has a second channel
//                     telling them market data is down and needs a manual
//                     reconnect at /api/market/upstox/login.
//
//  If UPSTOX_API_KEY/UPSTOX_SECRET aren't set, both jobs no-op quietly —
//  this file never crashes the server and never fabricates a "connected"
//  status; it only reports what marketDataService actually finds.
// ══════════════════════════════════════════════════════════════════════════

const cron = require('node-cron');
const { config } = require('../config');
const marketDataService = require('./marketDataService');
const { sendUpstoxTokenAlert } = require('./emailService');
const { evaluateDuePredictions } = require('./predictionAccuracyService');
const { evaluateDueScannerSignals } = require('./scannerAccuracyService');

function isUpstoxConfigured() {
  return !!(config.upstox.apiKey && config.upstox.apiSecret);
}

async function runDailyTokenRequest() {
  if (!isUpstoxConfigured()) {
    console.warn('[tokenScheduler] Skipping daily Upstox token request — UPSTOX_API_KEY/UPSTOX_SECRET not set.');
    return;
  }
  try {
    const { authorizationExpiry } = await marketDataService.requestAccessTokenApproval();
    console.log(`[tokenScheduler] Upstox approval request sent — approve on your phone before ${authorizationExpiry.toISOString()}.`);
  } catch (err) {
    console.error('[tokenScheduler] Failed to send Upstox approval request:', err.message);
    if (config.adminAlertEmail) {
      try {
        await sendUpstoxTokenAlert(config.adminAlertEmail, { connected: false, reason: err.message });
      } catch (mailErr) {
        console.error('[tokenScheduler] Also failed to send backup alert email:', mailErr.message);
      }
    }
  }
}

async function runFollowUpCheck() {
  if (!isUpstoxConfigured()) return;
  try {
    const status = await marketDataService.upstoxStatus();
    if (status.connected) {
      console.log(`[tokenScheduler] Upstox connected — token valid until ${status.expiresAt}.`);
      return;
    }
    console.warn('[tokenScheduler] Upstox still not connected after the daily approval window — sending backup alert.');
    if (config.adminAlertEmail) {
      await sendUpstoxTokenAlert(config.adminAlertEmail, {
        connected: false,
        reason: 'the approval request was sent but no token was received — the phone/WhatsApp approval may have been missed',
      });
    }
  } catch (err) {
    console.error('[tokenScheduler] Follow-up status check failed:', err.message);
  }
}

/** Starts both cron jobs. Call once at server startup. */
function startUpstoxTokenScheduler() {
  if (!isUpstoxConfigured()) {
    console.warn('[tokenScheduler] Upstox not configured — automatic daily token refresh is disabled until UPSTOX_API_KEY/UPSTOX_SECRET are set.');
  }
  if (!config.adminAlertEmail) {
    console.warn('[tokenScheduler] ADMIN_ALERT_EMAIL not set — missed phone approvals will only be visible in server logs, not emailed.');
  }

  // 08:00 IST daily — send the phone-approval request.
  cron.schedule('0 8 * * *', runDailyTokenRequest, { timezone: 'Asia/Kolkata' });
  // 08:45 IST daily — confirm it actually landed; alert by email if not.
  cron.schedule('45 8 * * *', runFollowUpCheck, { timezone: 'Asia/Kolkata' });

  // 18:00 IST daily (well after market close at 15:30 IST) — check every
  // sentiment call whose horizon has now passed against the REAL price and
  // record correct/incorrect, so the admin AI-accuracy dashboard is always
  // studying real outcomes, not stale/pending rows.
  cron.schedule('0 18 * * *', () => {
    evaluateDuePredictions().catch(err =>
      console.error('[tokenScheduler] Prediction accuracy evaluation failed:', err.message)
    );
  }, { timezone: 'Asia/Kolkata' });

  // Same 18:00 IST slot — checks every Screener technical signal (ALL
  // stocks, ALL Time Interval chips) whose horizon has passed against the
  // real price. See scannerAccuracyService.js.
  cron.schedule('0 18 * * *', () => {
    evaluateDueScannerSignals().catch(err =>
      console.error('[tokenScheduler] Scanner signal accuracy evaluation failed:', err.message)
    );
  }, { timezone: 'Asia/Kolkata' });

  console.log('[tokenScheduler] Automatic daily Upstox token refresh scheduled (08:00 IST request, 08:45 IST follow-up check).');
  console.log('[tokenScheduler] Automatic daily AI-prediction accuracy evaluation scheduled (18:00 IST).');
  console.log('[tokenScheduler] Automatic daily Scanner-signal accuracy evaluation scheduled (18:00 IST).');
}

module.exports = { startUpstoxTokenScheduler, runDailyTokenRequest, runFollowUpCheck };
