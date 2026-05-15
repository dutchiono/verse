# Open Source Release Checklist

1. Verify no runtime secrets are committed:
   - `.env`
   - `config/users.json`
   - `config/wallets.encrypted.json`
2. Replace any real keys in docs/examples with placeholders.
3. Confirm first-user bootstrap and admin login flow on a clean copy.
4. Confirm operators cannot perform admin write actions.
5. Confirm production deploy binds backend to loopback only:
   - `SERVER_HOST=127.0.0.1`
6. Confirm TLS termination and auth proxy setup in nginx.
7. Rotate any previously exposed API keys before publishing.
