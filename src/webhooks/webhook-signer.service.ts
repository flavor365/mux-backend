import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

export interface WebhookSignature {
  timestamp: number;
  signature: string;
}

/**
 * Service for signing and verifying webhook payloads.
 *
 * Dual-secret rotation support:
 * Use `verifySignatureWithFallback` when a rotation window is active — it
 * accepts signatures produced with either the current or the pending secret.
 */
@Injectable()
export class WebhookSignerService {
  /**
   * Signs a webhook payload using HMAC-SHA256
   */
  signPayload(payload: string, secret: string, timestamp: number): string {
    const signedPayload = `${timestamp}.${payload}`;
    return crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');
  }

  /**
   * Generates signature headers for a webhook request
   */
  generateSignatureHeaders(
    payload: any,
    secret: string,
  ): { timestamp: number; signature: string } {
    const timestamp = Math.floor(Date.now() / 1000);
    const payloadString = JSON.stringify(payload);
    const signature = this.signPayload(payloadString, secret, timestamp);

    return { timestamp, signature };
  }

  /**
   * Verifies a webhook signature against a single secret.
   *
   * Use this on the receiving end to verify authenticity.
   */
  verifySignature(
    payload: string,
    signature: string,
    secret: string,
    timestamp: number,
    toleranceSeconds: number = 300, // 5 minutes
  ): boolean {
    // Check timestamp to prevent replay attacks
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - timestamp) > toleranceSeconds) {
      return false;
    }

    return this.constantTimeMatch(payload, signature, secret, timestamp);
  }

  /**
   * Verifies a webhook signature during a dual-secret rotation window.
   *
   * Both `primarySecret` (the current/new secret) and `pendingSecret` (the
   * previous/outgoing secret still within the overlap window) are tried.
   * Returns `true` if either produces a matching signature.
   *
   * @param pendingSecretExpiresAt  When the overlap window closes.  If
   *   `undefined` or already expired only `primarySecret` is tried.
   */
  verifySignatureWithFallback(
    payload: string,
    signature: string,
    primarySecret: string,
    timestamp: number,
    pendingSecret?: string | null,
    pendingSecretExpiresAt?: Date | null,
    toleranceSeconds: number = 300,
  ): boolean {
    // Timestamp replay guard
    const currentTime = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTime - timestamp) > toleranceSeconds) {
      return false;
    }

    // Always try primary secret first
    if (this.constantTimeMatch(payload, signature, primarySecret, timestamp)) {
      return true;
    }

    // Fall back to pending secret if the rotation window is still open
    if (
      pendingSecret &&
      pendingSecretExpiresAt &&
      pendingSecretExpiresAt > new Date()
    ) {
      return this.constantTimeMatch(
        payload,
        signature,
        pendingSecret,
        timestamp,
      );
    }

    return false;
  }

  /**
   * Formats signature for HTTP header
   */
  formatSignatureHeader(timestamp: number, signature: string): string {
    return `t=${timestamp},v1=${signature}`;
  }

  /**
   * Parses signature from HTTP header
   */
  parseSignatureHeader(
    header: string,
  ): { timestamp: number; signature: string } | null {
    const parts = header.split(',');
    const timestamp = parts.find((p) => p.startsWith('t='));
    const signature = parts.find((p) => p.startsWith('v1='));

    if (!timestamp || !signature) {
      return null;
    }

    return {
      timestamp: parseInt(timestamp.split('=')[1], 10),
      signature: signature.split('=')[1],
    };
  }

  /**
   * Constant-time HMAC comparison for a single (payload, signature, secret) triple.
   */
  private constantTimeMatch(
    payload: string,
    signature: string,
    secret: string,
    timestamp: number,
  ): boolean {
    const expected = this.signPayload(payload, secret, timestamp);

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    // timingSafeEqual requires equal lengths; mismatched length = invalid
    if (a.length !== b.length) {
      return false;
    }

    return crypto.timingSafeEqual(a, b);
  }
}
