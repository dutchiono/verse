import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

const USERS_FILE = path.resolve("config/users.json");
const MIN_PASSWORD_LENGTH = Math.max(
  8,
  Number.parseInt(process.env.USER_MIN_PASSWORD_LENGTH ?? "12", 10) || 12,
);

export type UserRole = "admin" | "operator";

export interface PublicUser {
  username: string;
  createdAt: number;
  role: UserRole;
  controlWalletName?: string;
}

interface UserRecord extends PublicUser {
  passwordHash: string;
}

class UsersStore {
  private users: UserRecord[] = [];

  constructor() {
    this.load();
  }

  private load() {
    if (!existsSync(USERS_FILE)) { this.users = []; return; }
    try {
      const parsed = JSON.parse(readFileSync(USERS_FILE, "utf8"));
      this.users = (Array.isArray(parsed) ? parsed : []).map((u: any) => ({
        username: String(u.username ?? "").trim(),
        createdAt: Number(u.createdAt ?? Date.now()),
        passwordHash: String(u.passwordHash ?? ""),
        role: (u.role === "admin" ? "admin" : "operator") as UserRole,
        controlWalletName: u.controlWalletName ? String(u.controlWalletName) : undefined,
      })).filter((u: UserRecord) => Boolean(u.username) && Boolean(u.passwordHash));
      this.ensureAdminInvariant();
    } catch {
      this.users = [];
    }
  }

  private save() {
    mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    writeFileSync(USERS_FILE, JSON.stringify(this.users, null, 2));
  }

  private ensureAdminInvariant() {
    if (this.users.length === 0) return;
    if (this.users.some((u) => u.role === "admin")) return;
    this.users[0]!.role = "admin";
    this.save();
  }

  private validatePassword(password: string) {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }

  list(): PublicUser[] {
    return this.users.map(({ username, createdAt, role, controlWalletName }) => ({ username, createdAt, role, controlWalletName }));
  }

  count(): number {
    return this.users.length;
  }

  has(username: string): boolean {
    return this.users.some(u => u.username.toLowerCase() === username.toLowerCase().trim());
  }

  get(username: string): PublicUser | null {
    const user = this.users.find((u) => u.username.toLowerCase() === username.toLowerCase().trim());
    if (!user) return null;
    return { username: user.username, createdAt: user.createdAt, role: user.role, controlWalletName: user.controlWalletName };
  }

  setControlWallet(username: string, walletName: string | null): void {
    const user = this.users.find((u) => u.username.toLowerCase() === username.toLowerCase().trim());
    if (!user) throw new Error(`user "${username}" not found`);
    if (walletName) user.controlWalletName = walletName;
    else delete user.controlWalletName;
    this.save();
  }

  clearControlWalletReferences(walletName: string): void {
    let changed = false;
    for (const user of this.users) {
      if (user.controlWalletName === walletName) {
        delete user.controlWalletName;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  isAdmin(username: string): boolean {
    const user = this.users.find((u) => u.username.toLowerCase() === username.toLowerCase().trim());
    return user?.role === "admin";
  }

  async add(username: string, password: string, role: UserRole = "operator"): Promise<PublicUser> {
    const name = username.trim();
    if (!name || name.length < 2) throw new Error("username must be at least 2 characters");
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("username may only contain letters, numbers, _ and -");
    this.validatePassword(password);
    if (this.has(name)) throw new Error(`user "${name}" already exists`);
    const passwordHash = await Bun.password.hash(password);
    const assignedRole: UserRole = this.users.length === 0 ? "admin" : role;
    const rec: UserRecord = { username: name, passwordHash, createdAt: Date.now(), role: assignedRole };
    this.users.push(rec);
    this.save();
    return { username: rec.username, createdAt: rec.createdAt, role: rec.role };
  }

  async verify(username: string, password: string): Promise<boolean> {
    const user = this.users.find(u => u.username.toLowerCase() === username.toLowerCase().trim());
    if (!user) return false;
    return Bun.password.verify(password, user.passwordHash);
  }

  remove(username: string): void {
    const before = this.users.length;
    const target = this.users.find((u) => u.username.toLowerCase() === username.toLowerCase().trim());
    this.users = this.users.filter((u) => u.username.toLowerCase() !== username.toLowerCase().trim());
    if (this.users.length === before) throw new Error(`user "${username}" not found`);
    if (this.users.length === 0) throw new Error("cannot remove the last user — add another first");
    if (target?.role === "admin" && !this.users.some((u) => u.role === "admin")) {
      throw new Error("cannot remove the last admin user");
    }
    this.save();
  }

  async changePassword(username: string, newPassword: string): Promise<void> {
    const user = this.users.find(u => u.username.toLowerCase() === username.toLowerCase().trim());
    if (!user) throw new Error(`user "${username}" not found`);
    this.validatePassword(newPassword);
    user.passwordHash = await Bun.password.hash(newPassword);
    this.save();
  }
}

export const users = new UsersStore();
