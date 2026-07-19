# Fix: users who open the site from the Instagram bio link can't sign in with Google, and get signed out repeatedly

## The symptom
Visitors tapping the link in the Instagram bio (or any Instagram post/DM)
land on the site inside **Instagram's own in-app browser**, not Chrome or
Safari. There, Google Sign-In doesn't work normally — instead of the usual
one-tap "choose your Google account", people are forced to manually type
their email and password. Even after getting in, they get signed out again
after a short while and have to repeat the whole process.

## Root cause
The login page is Google Sign-In only (the email/password form was
intentionally removed — see `CHANGES-*` history). Google's Identity Services
SDK **deliberately blocks or degrades its Sign-In flow inside embedded/
in-app browsers** (Instagram, Facebook, Messenger, TikTok, Line, Snapchat,
and generic Android WebViews) as an anti-phishing measure — this is a Google
policy, not something specific to this site. Two consequences fall out of
that:

1. **Manual email/password typing** — inside the blocked flow, Google falls
   back to a degraded consent screen that requires typing credentials by
   hand instead of the normal account chooser.
2. **Repeated sign-outs** — Instagram's in-app browser also does not
   reliably persist the cross-site `refreshToken` cookie the site's "stay
   signed in" flow depends on (see `CHANGES-stay-signed-in-fix.md`). The
   cookie logic itself is correct (15-min access token + 30-day refresh
   cookie, `SameSite=None; Secure`), but Instagram's webview clears/resets
   cookies on backgrounding or on a webview reload, so the session silently
   disappears — independent of any real 30-day/30-minute expiry.

Neither of these is fixable from inside the webview — they're restrictions
Google and Instagram enforce outside this app's control. The fix is to get
the visitor out of the in-app browser and into their real browser, where
both Google Sign-In and cookie persistence work exactly as designed.

## The fix
`frontend/index.html`:
- Added `isInAppBrowser()` — detects Instagram/Facebook/Messenger/TikTok/
  Line/Snapchat/generic Android WebView user agents.
- The login page now shows a clear banner ("You're viewing this inside
  Instagram's in-app browser…") with an **"Open in browser"** button when
  an in-app browser is detected, and skips rendering the (broken) Google
  button there instead of letting people hit a dead end.
- `openInSystemBrowser()` — on Android, hands the page off to Chrome via an
  `intent://` URL. iOS gives in-app browsers no API to force-launch Safari,
  so there it copies the link and points people at Instagram's own
  ••• menu → "Open in Browser" option (the only reliable path Instagram
  provides on iOS).
- Added a `visibilitychange` / `pageshow` re-check (`revalidateSessionIfNeeded`)
  that silently re-runs session restore when a backgrounded/bfcache-restored
  tab becomes visible again, so a stale in-memory `authToken` doesn't show a
  login wall when the 30-day refresh cookie is actually still valid — this
  helps on any mobile browser, not just Instagram's.

No backend changes were needed; the cookie/session logic there was already
correct per `CHANGES-stay-signed-in-fix.md`.

## Files changed
- `frontend/index.html`
