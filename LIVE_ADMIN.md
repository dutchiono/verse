# Live Admin Guide

## Server-side user file
- Runtime user auth is stored at `config/users.json` on the server.
- This file is intentionally ignored by git.

## Add a whitelisted user (admin only)
1. Sign in to Verse as an admin.
2. Open **Users**.
3. Add user with a strong password.

## Change a user password
1. Sign in as admin.
2. Open **Users**.
3. Use **Change password**.

## Remove a user
1. Sign in as admin.
2. Open **Users**.
3. Remove the user from the list.

## Emergency lock down
- Rotate all Verse user passwords.
- Rotate wallet unlock password (`/api/rotate-password` as admin).
- Remove untrusted users from Verse.
- Restart service:
  - `sudo systemctl restart verse.service`

## Deploy note
- Keep Verse backend bound to loopback:
  - `SERVER_HOST=127.0.0.1`
- Public access should remain via nginx TLS only.
