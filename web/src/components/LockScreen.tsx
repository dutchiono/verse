import { useState } from "react";
import { api, authToken } from "../api";

interface Props {
  noUsers: boolean;
  onLogin: (token: string, username: string, isAdmin: boolean) => void;
}

export function LockScreen({ noUsers, onLogin }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!username.trim()) { setErr("username required"); return; }
    if (!password) { setErr("password required"); return; }
    if (noUsers && password !== confirm) { setErr("passwords don't match"); return; }

    setBusy(true);
    try {
      if (noUsers) {
        // Bootstrap: create first user, then log in
        await api.addUser(username.trim(), password);
      }
      const { token, username: user, isAdmin } = await api.login(username.trim(), password);
      authToken.set(token);
      onLogin(token, user, isAdmin);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lock-screen">
      <div className="lock-card">
        <h1>Verse</h1>
        <p className="muted small">
          {noUsers
            ? "First time setup — create an admin account."
            : "Sign in to continue."}
        </p>
        <form onSubmit={submit}>
          <label>
            <span>Username</span>
            <input
              type="text"
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your username"
              disabled={busy}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              autoComplete={noUsers ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={noUsers ? "at least 12 characters" : ""}
              disabled={busy}
            />
          </label>
          {noUsers && (
            <label>
              <span>Confirm password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={busy}
              />
            </label>
          )}
          {err && <div className="err">{err}</div>}
          <button type="submit" disabled={busy} style={{ marginTop: 4 }}>
            {busy ? "…" : noUsers ? "Create account & sign in" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
