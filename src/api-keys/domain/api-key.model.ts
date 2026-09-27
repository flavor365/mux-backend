/**
 * Domain model for API Keys
 */

export enum ApiKeyStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
  EXPIRED = 'EXPIRED',
  SUSPENDED = 'SUSPENDED',
}

export interface ApiKey {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  lastFour: string;
  projectId: string;
  status: ApiKeyStatus;
  expiresAt?: Date | null;
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
  revokedReason?: string | null;
  gracePeriodEndsAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Developer {
  id: string;
  email: string;
  name?: string | null;
  company?: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  developerId: string;
  status: string;
  environment: string;
  rateLimitRpm: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Validated API key context extracted from request
 */
export interface ApiKeyContext {
  apiKey: ApiKey;
  project: Project;
  developer: Developer;
}

/**
 * Stable machine-readable error codes for API key validation failures.
 * Clients can branch on `errorCode` without parsing human-readable messages.
 */
export const ApiKeyErrorCode = {
  /** Key format is not recognised (wrong prefix, length, etc.) */
  INVALID_FORMAT: 'API_KEY_INVALID_FORMAT',
  /** Key was not found in the database */
  NOT_FOUND: 'API_KEY_NOT_FOUND',
  /** Key exists but has been revoked */
  REVOKED: 'API_KEY_REVOKED',
  /** Key exists but is currently suspended */
  SUSPENDED: 'API_KEY_SUSPENDED',
  /** Key has expired (via expiresAt or grace-period exhausted) */
  EXPIRED: 'API_KEY_EXPIRED',
  /**
   * The network implied by the key prefix (live/test) does not match the
   * network required by the requested operation.
   * e.g. a `mux_live_…` key used against a TESTNET endpoint.
   */
  NETWORK_MISMATCH: 'API_KEY_NETWORK_MISMATCH',
} as const;

export type ApiKeyErrorCode =
  (typeof ApiKeyErrorCode)[keyof typeof ApiKeyErrorCode];

/**
 * Allowed status transitions for API keys
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<ApiKeyStatus, ReadonlySet<ApiKeyStatus>>
> = {
  [ApiKeyStatus.ACTIVE]: new Set([
    ApiKeyStatus.REVOKED,
    ApiKeyStatus.EXPIRED,
    ApiKeyStatus.SUSPENDED,
  ]),
  [ApiKeyStatus.SUSPENDED]: new Set([
    ApiKeyStatus.ACTIVE,
    ApiKeyStatus.REVOKED,
  ]),
  [ApiKeyStatus.EXPIRED]: new Set([]), // Cannot transition from expired
  [ApiKeyStatus.REVOKED]: new Set([]), // Cannot transition from revoked
};

export function canTransitionApiKeyStatus(
  from: ApiKeyStatus,
  to: ApiKeyStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}
