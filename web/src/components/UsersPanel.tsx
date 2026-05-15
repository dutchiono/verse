import { useEffect, useState } from "react";
import { api } from "../api";

interface UserRow {
  username: string;
  createdAt: number;
  role?: "admin" | "operator";
}

interface Props {
  currentUsername: string;
  isAdmin: boolean;
}

export function UsersPanel({ currentUsername, isAdmin }: Props) {
  const [userList, setUserList] = useState<UserRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Add form
  const [newUser, setNewUser] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newPass2, setNewPass2] = useState("");

  // Change-password form
  const [cpTarget, setCpTarget] = useState("");
  const [cpPass, setCpPass] = useState("");
  const [cpPass2, setCpPass2] = useState("");

  useEffect(() => { void load(); }, [isAdmin]);

  async function load() {
    if (!isAdmin) {
      setUserList([{ username: currentUsername, createdAt: Date.now() }]);
      return;
    }
    try {
      const r = await api.listUsers();
      setUserList(r.users);
    } catch {
      setUserList([]);
    }
  }

  function flash(msg: string) {
    setOk(msg);
    setTimeout(() => setOk(null), 3000);
  }

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!isAdmin) { setErr("admin access required"); return; }
    if (newPass !== newPass2) { setErr("passwords don't match"); return; }
    setBusy(true);
    try {
      await api.addUser(newUser.trim(), newPass);
      setNewUser(""); setNewPass(""); setNewPass2("");
      flash(`user "${newUser.trim()}" added`);
      await load();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function removeUser(username: string) {
    if (!isAdmin) { setErr("admin access required"); return; }
    if (!confirm(`Remove user "${username}"? They will be signed out immediately.`)) return;
    setErr(null);
    try {
      await api.deleteUser(username);
      flash(`user "${username}" removed`);
      await load();
    } catch (e) { setErr((e as Error).message); }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (cpPass !== cpPass2) { setErr("passwords don't match"); return; }
    const target = isAdmin ? cpTarget : currentUsername;
    if (!target) { setErr("user required"); return; }
    setBusy(true);
    try {
      await api.changeUserPassword(target, cpPass);
      setCpTarget(""); setCpPass(""); setCpPass2("");
      flash("password changed");
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="users-panel">
      <div className="users-panel-head">
        <span className="users-panel-title">Users</span>
        <span className="small muted">signed in as <strong>{currentUsername}</strong></span>
      </div>
      {!isAdmin && (
        <div className="small muted" style={{ marginBottom: 8 }}>
          Operator account: you can change only your own password.
        </div>
      )}

      {err && <div className="err small">{err}</div>}
      {ok && <div className="small" style={{ color: "var(--accent)", marginBottom: 6 }}>✓ {ok}</div>}

      {/* User list */}
      {isAdmin && (
        <div className="users-list">
          {userList.length === 0 && <div className="muted small">no users</div>}
          {userList.map(u => (
            <div key={u.username} className="users-row">
              <span className="users-name">{u.username}</span>
              {u.username === currentUsername && (
                <span className="small muted" style={{ marginLeft: 6 }}>(you)</span>
              )}
              <span className="users-spacer" />
              <span className="small muted">{u.role ?? "operator"} · {new Date(u.createdAt).toLocaleDateString()}</span>
              {u.username !== currentUsername && (
                <button
                  className="ghost small danger"
                  onClick={() => void removeUser(u.username)}
                  title="remove user"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add user */}
      {isAdmin && <details className="users-section">
        <summary className="users-section-title">Add user</summary>
        <form onSubmit={addUser} style={{ marginTop: 10 }}>
          <div className="users-form-row">
            <input
              className="users-input"
              placeholder="username"
              value={newUser}
              onChange={e => setNewUser(e.target.value)}
              disabled={busy}
              autoComplete="off"
            />
            <input
              className="users-input"
              type="password"
              placeholder="password"
              value={newPass}
              onChange={e => setNewPass(e.target.value)}
              disabled={busy}
              autoComplete="new-password"
            />
            <input
              className="users-input"
              type="password"
              placeholder="confirm"
              value={newPass2}
              onChange={e => setNewPass2(e.target.value)}
              disabled={busy}
              autoComplete="new-password"
            />
            <button type="submit" disabled={busy || !newUser.trim() || !newPass || !newPass2}>
              {busy ? "…" : "Add"}
            </button>
          </div>
        </form>
      </details>}

      {/* Change password */}
      <details className="users-section">
        <summary className="users-section-title">Change password</summary>
        <form onSubmit={changePassword} style={{ marginTop: 10 }}>
          <div className="users-form-row">
            {isAdmin ? (
              <select
                className="users-input"
                value={cpTarget}
                onChange={e => setCpTarget(e.target.value)}
                disabled={busy}
              >
                <option value="">select user…</option>
                {userList.map(u => (
                  <option key={u.username} value={u.username}>{u.username}</option>
                ))}
              </select>
            ) : (
              <input className="users-input" value={currentUsername} disabled />
            )}
            <input
              className="users-input"
              type="password"
              placeholder="new password"
              value={cpPass}
              onChange={e => setCpPass(e.target.value)}
              disabled={busy}
              autoComplete="new-password"
            />
            <input
              className="users-input"
              type="password"
              placeholder="confirm"
              value={cpPass2}
              onChange={e => setCpPass2(e.target.value)}
              disabled={busy}
              autoComplete="new-password"
            />
            <button type="submit" disabled={busy || (isAdmin && !cpTarget) || !cpPass || !cpPass2}>
              {busy ? "…" : "Change"}
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}
