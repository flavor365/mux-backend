# Backup & Restore Procedures — Mux Backend

> **Status:** Production runbook  
> **Owner:** Platform / SRE  
> **Last drill:** 2026-09-27  
> **References:** Issue #979

---

## 1. Scope

This document covers:

- PostgreSQL database backups (primary data store via Prisma/PgSQL)
- Encrypted wallet key material (via `WALLET_ENCRYPTION_KEY` + AES-256-GCM)
- Environment secrets (`.env` / hosted secret manager values)
- Restoration procedures and drill evidence checklist

**Out of scope:** Stellar on-chain state (immutable, always recoverable from chain).

---

## 2. Backup Assets

| Asset | Storage | Frequency | Retention |
|---|---|---|---|
| PostgreSQL full dump | Object storage (encrypted) | Daily 02:00 UTC | 30 days |
| PostgreSQL WAL/PITR | Managed DB provider logs | Continuous | 7 days |
| `WALLET_ENCRYPTION_KEY` | Secret manager (never in DB) | On rotation | Previous 2 versions |
| Environment secrets | Secret manager | On change | Previous 3 versions |

---

## 3. Database Backup

### 3.1 Manual Backup

```bash
# Full logical dump (replace placeholders)
pg_dump \
  --format=custom \
  --no-acl \
  --no-owner \
  --verbose \
  "$DATABASE_URL" \
  > "mux_backup_$(date +%Y%m%dT%H%M%SZ).dump"
```

Store the dump in an encrypted bucket. Never commit dump files to version control.

### 3.2 Automated Backup Verification

Automated backups should be verified weekly:

```bash
# List recent backups (adjust for your bucket/provider)
aws s3 ls s3://mux-backups/postgres/ --recursive | tail -10
```

---

## 4. Restore Procedures

### 4.1 Database Restore (Full)

```bash
# 1. Provision a clean database (same PG version)
# 2. Apply migrations first to ensure schema consistency
pnpm prisma:migrate:prod

# 3. Restore data
pg_restore \
  --verbose \
  --clean \
  --no-acl \
  --no-owner \
  --dbname="$DATABASE_URL" \
  mux_backup_<TIMESTAMP>.dump
```

> **Invariant:** Always run migrations *before* restoring data when the backup
> may pre-date the current schema version. If the backup was taken after the
> migration it is safe to skip step 2.

### 4.2 Point-in-Time Recovery (PITR)

For managed providers (Railway, Supabase, RDS, etc.) use the platform's PITR
UI to select a recovery timestamp. Confirm the target timestamp with the
incident timeline before initiating.

### 4.3 Wallet Encryption Key Recovery

The `WALLET_ENCRYPTION_KEY` is **never** stored in the database. If it is
lost, all encrypted wallet secrets become unrecoverable.

1. Retrieve the key from the secret manager (e.g. AWS Secrets Manager, Doppler).
2. Set it in the environment before starting the application.
3. Rotate only via the documented key-rotation flow (see
   `docs/key-management-consolidation.md`) to avoid breaking existing wallets.

---

## 5. Drill Procedure & Evidence Checklist

Run this drill quarterly on a staging environment. Record outcomes below.

### Pre-Drill

- [ ] Identify the target backup timestamp
- [ ] Confirm staging DB is isolated from production
- [ ] Verify `WALLET_ENCRYPTION_KEY` for staging is available in the secret manager
- [ ] Ensure at least one engineer with DB admin access is available

### Drill Steps

1. **Snapshot baseline** — record row counts for key tables:

   ```sql
   SELECT
     (SELECT COUNT(*) FROM "User")        AS users,
     (SELECT COUNT(*) FROM "Wallet")      AS wallets,
     (SELECT COUNT(*) FROM "Transaction") AS transactions;
   ```

2. **Drop and recreate** the staging database (or use a separate restore target).

3. **Run migrations**:

   ```bash
   DATABASE_URL=<staging_url> pnpm prisma:migrate:prod
   ```

4. **Restore the dump**:

   ```bash
   pg_restore --verbose --clean --no-acl --no-owner \
     --dbname="<staging_url>" mux_backup_<TIMESTAMP>.dump
   ```

5. **Start the application** against the restored database.

6. **Smoke-test** key endpoints:

   ```bash
   curl -f http://localhost:3000/v1/health
   curl -f http://localhost:3000/v1/ready
   ```

7. **Verify row counts** match the pre-dump baseline recorded in step 1.

8. **Attempt a wallet decrypt** operation to confirm `WALLET_ENCRYPTION_KEY` is
   correct and encrypted secrets are intact.

### Post-Drill

- [ ] Record actual vs expected row counts (diff acceptable if time elapsed)
- [ ] Record `/health` and `/ready` response status
- [ ] Record whether wallet decryption succeeded
- [ ] Log any deviations and open follow-up issues

### Drill Log

| Date | Operator | Backup Timestamp Used | Result | Notes |
|---|---|---|---|---|
| 2026-09-27 | Platform SRE | Latest daily | ✅ Pass | Initial drill on staging |

---

## 6. Fail-Closed Invariants

- If `WALLET_ENCRYPTION_KEY` is missing at boot the application **fails to start** (validated in `src/app.service.ts`).
- A failed DB restore leaves the application in a non-ready state; `/ready` returns `503` until the DB is reachable.
- Backup files must be encrypted at rest. Never store plaintext dumps in shared storage.
- Drill results must be appended to the table above and reviewed at each quarterly security review.

---

## 7. Rollback Strategy

If a restore introduces regressions:

1. Re-point `DATABASE_URL` to the previous primary (blue/green) if applicable.
2. Re-run `pnpm prisma:migrate:prod` to ensure schema consistency.
3. Re-deploy the previous application image.
4. Alert on-call via the standard incident channel.

---

## 8. Cross-References

- [Key Management Consolidation](./key-management-consolidation.md)
- [Custody Security Model](./custody-security-model.md)
- [Key Rotation Audit](../src/key-management/key-rotation-audit.service.ts)
- [Migration Guide](./MIGRATION-KEY-MANAGEMENT.md)
- `WALLET_ENCRYPTION_KEY` validation: `src/app.service.ts`
