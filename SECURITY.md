# Security Model

## Wallet safety
- Private keys are never stored in plaintext on disk.
- Wallets are stored in `config/wallets.encrypted.json` using AES-256-GCM encryption.
- Encryption key material is derived from the unlock password (scrypt KDF).
- In-memory decrypted keys exist only while the session is unlocked.

## Auth safety
- User passwords are stored as hashes in `config/users.json` (never plaintext).
- Minimum password length defaults to 12 characters (override with `USER_MIN_PASSWORD_LENGTH`, minimum 8).
- Login attempts are rate-limited and temporarily locked after repeated failures.
- API write operations are admin-only, except:
  - `POST /api/auth/logout`
  - `PUT /api/users/:username` for your own password

## Roles
- First created user is `admin`.
- New users are `operator` by default.
- Operators can sign in and change only their own password.
- Admins can add/remove users and perform privileged system actions.

## Open-source hygiene
- Never commit `.env`.
- Never commit `config/wallets.encrypted.json`.
- Never commit `config/users.json`.
- Keep `SERVER_HOST=127.0.0.1` and expose Verse only through nginx + HTTPS.

## Production recommendations
- Disable `AUTO_UNLOCK_PASSWORD` in production.
- Keep SSH restricted to trusted users and disable root login.
- Use strong, unique passwords for all Verse users.
- Rotate passwords if access is shared or suspected compromised.
