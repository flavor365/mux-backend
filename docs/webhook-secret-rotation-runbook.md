# Webhook Secret Rotation Runbook

> **Status:** Production runbook  
> **Owner:** Platform / SRE  
> **References:** Issue #978

---

## Overview

Mux webhooks use HMAC-SHA256 signatures for payload authenticity. Each
`WebhookEndpoint` has a primary `secret` used to sign outbound deliveries.

To avoid downtime when rotating secrets, the system supports a **dual-secret
overlap window**: after rotation both the old and new secrets are accepted by
consumers until `pendingSecretExpiresAt` expires.

---

## How Dual-Secret Rotation Works

```
┌────────────────────────────────────────────────────────────┐
│  Before rotation                                           │
│  secret = "whsec_OLD..."   pendingSecret = null            │
└────────────────────────────────────────────────────────────┘
              ↓  POST /webhooks/endpoints/:id/rotate-secret
┌────────────────────────────────────────────────────────────┐
│  During window (default 24 h)                              │
│  secret = "whsec_NEW..."   pendingSecret = "whsec_OLD..."  │
│  pendingSecretExpiresAt = <now + windowSeconds>            │
│                                                            │
│  Outbound deliveries: signed with NEW secret only          │
│  Inbound verification: NEW or OLD both accepted            │
└────────────────────────────────────────────────────────────┘
              ↓  after pendingSecretExpiresAt
┌────────────────────────────────────────────────────────────┐
│  After window                                              │
│  secret = "whsec_NEW..."   pendingSecret expired / ignored │
│  Only NEW secret accepted                                  │
└────────────────────────────────────────────────────────────┘
```

The window duration is configured via
`WEBHOOK_SECRET_ROTATION_WINDOW_SECONDS` (default: `86400` = 24 hours).

---

## Rotation API

### Initiate rotation

```
POST /v1/webhooks/endpoints/:id/rotate-secret
Authorization: Bearer <api-key>
```

Response:

```json
{
  "secret": "whsec_NEW...",
  "pendingSecretExpiresAt": "2026-09-28T09:49:02.235Z",
  "windowSeconds": 86400,
  "rotatedAt": "2026-09-27T09:49:02.235Z"
}
```

- **Store `secret` immediately** — it is returned only once.
- Update all consumers to verify with `whsec_NEW...` before `pendingSecretExpiresAt`.

### Verify a signature (consumer side)

```
X-Webhook-Signature: t=<timestamp>,v1=<hex-signature>
```

During the overlap window accept signatures produced by either secret:

```ts
// Using WebhookSignerService.verifySignatureWithFallback()
const valid = signerService.verifySignatureWithFallback(
  rawBody,        // string payload
  signature,      // from X-Webhook-Signature header
  newSecret,
  timestamp,
  oldSecret,              // optional: pendingSecret
  pendingSecretExpiresAt, // optional: when fallback expires
);
```

---

## Rotation Runbook

1. **Initiate rotation** via the API (see above). Record `pendingSecretExpiresAt`.
2. **Update consumers** — deploy updated secret to all downstream services.
3. **Monitor delivery success rate** — check `consecutiveFailures` per endpoint
   via `GET /v1/webhooks/endpoints/:id`.
4. **Confirm** all consumers are using the new secret before `pendingSecretExpiresAt`.
5. **No manual cleanup required** — after `pendingSecretExpiresAt` the old secret
   is ignored automatically.

---

## Security Considerations

- Secrets are stored server-side only; never returned in `GET` responses.
- Signatures use constant-time comparison (`crypto.timingSafeEqual`) to prevent
  timing attacks.
- Replay protection: timestamp tolerance of ±300 seconds enforced on verification.
- The `pendingSecret` field is **not** included in webhook endpoint list/get
  responses to avoid leaking it.
- Set `WEBHOOK_SECRET_ROTATION_WINDOW_SECONDS` to the minimum time your team
  needs to deploy updated secrets to all consumers. Shorter is safer.

---

## Rollback

If the new secret was distributed incorrectly:

1. Initiate another rotation immediately — this resets the window with a fresh secret.
2. The previous `pendingSecret` is overwritten; ensure consumers update promptly.

---

## Cross-References

- `src/webhooks/webhook-signer.service.ts` — `verifySignatureWithFallback`
- `src/webhooks/webhook.service.ts` — `rotateSecret`
- `docs/BACKUP_RESTORE_PROCEDURES.md`
- Migration: `prisma/migrations/20260927000000_webhook_dual_secret_rotation/`
