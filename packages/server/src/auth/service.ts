import type { AuthInput, PasswordChangeInput, User } from '@hcl/contracts';
import * as argon2 from 'argon2';
import { eq, sql } from 'drizzle-orm';
import { siteSettings, users } from '../db/schema.js';
import { DomainError } from '../errors.js';
import type { Database } from '../index.js';
import { publicUserColumns, toPublicUser } from '../users.js';

const argonOptions: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

// Shared by every service instance, including verification for missing accounts.
let activePasswordTasks = 0;
const passwordWaiters: Array<() => void> = [];
async function passwordTask<T>(task: () => Promise<T>): Promise<T> {
  if (activePasswordTasks >= 2) {
    const { promise, resolve } = Promise.withResolvers<void>();
    passwordWaiters.push(resolve);
    await promise;
  } else {
    activePasswordTasks++;
  }
  try {
    return await task();
  } finally {
    const next = passwordWaiters.shift();
    if (next) next();
    else activePasswordTasks--;
  }
}

// Public, deliberately unusable account-independent PHC; every failed lookup still verifies.
const DUMMY_PHC =
  '$argon2id$v=19$m=65536,t=3,p=1$ql/zGW4pbELRy4N2B/oIzg$Cmzxd51KdQ+4DU34nFQRLfFjazzH5EWpW825KvyQwFk';

export function normalizeUsername(value: string): { username: string; usernameKey: string } {
  const username = value.trim();
  const normalizedUsername = username.normalize('NFKC');
  const usernameKey = normalizedUsername.toLowerCase();
  const length = Array.from(normalizedUsername).length;
  if (length < 3 || length > 32 || !/^[\p{L}\p{N}_-]+$/u.test(normalizedUsername)) {
    throw new DomainError(
      400,
      'VALIDATION_ERROR',
      '用户名须为 3–32 个字母、数字、下划线或短横线。',
      {
        username: '请输入有效用户名。',
      },
    );
  }
  return { username, usernameKey };
}
function normalizeInput(input: AuthInput): {
  username: string;
  usernameKey: string;
  password: string;
} {
  const { username, usernameKey } = normalizeUsername(input.username);
  const passwordLength = Array.from(input.password).length;
  if (passwordLength < 12 || passwordLength > 128) {
    throw new DomainError(400, 'VALIDATION_ERROR', '密码须为 12–128 个字符。', {
      password: '密码须为 12–128 个字符，空格不会被移除。',
    });
  }
  return { username, usernameKey, password: input.password };
}

function isUsernameConflict(error: unknown): boolean {
  // Drizzle wraps the PostgreSQL error in a query error; inspect only that cause chain.
  const seen = new Set<unknown>();
  while (typeof error === 'object' && error !== null && !seen.has(error)) {
    seen.add(error);
    if (
      'code' in error &&
      error.code === '23505' &&
      'constraint' in error &&
      error.constraint === 'users_username_key_unique'
    )
      return true;
    error = 'cause' in error ? error.cause : undefined;
  }
  return false;
}

const publicUser = publicUserColumns;

export class AuthService {
  constructor(private readonly db: Database) {}

  async usernameAvailable(value: string): Promise<boolean> {
    const { usernameKey } = normalizeUsername(value);
    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameKey, usernameKey))
      .limit(1);
    return !user;
  }

  async register(input: AuthInput): Promise<User> {
    const { username, usernameKey, password } = normalizeInput(input);
    // Expensive work must never hold the first-owner transaction lock.
    const passwordHash = await passwordTask(() => argon2.hash(password, argonOptions));
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hcl:first-owner'))`);
        const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
        const [site] = await tx
          .select({ registrationOpen: siteSettings.registrationOpen })
          .from(siteSettings)
          .where(eq(siteSettings.id, 1));
        if (existing && !site?.registrationOpen)
          throw new DomainError(403, 'FORBIDDEN', '站点已关闭公开注册。');
        const [user] = await tx
          .insert(users)
          .values({
            username,
            usernameKey,
            displayName: username,
            passwordHash,
            role: existing ? 'member' : 'owner',
          })
          .returning(publicUser);
        if (!user) throw new Error('User insertion returned no row');
        return toPublicUser(user);
      });
    } catch (error) {
      if (isUsernameConflict(error)) {
        throw new DomainError(409, 'USERNAME_TAKEN', '该用户名已被使用。', {
          username: '该用户名已被使用。',
        });
      }
      throw error;
    }
  }

  async login(input: AuthInput): Promise<User> {
    const { usernameKey, password } = normalizeInput(input);
    const [user] = await this.db
      .select({ ...publicUser, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.usernameKey, usernameKey))
      .limit(1);
    const hash = user ? user.passwordHash : DUMMY_PHC;
    const matches = await passwordTask(() => argon2.verify(hash, password));
    if (!user || !matches) throw new DomainError(401, 'INVALID_CREDENTIALS', '用户名或密码错误。');
    return toPublicUser(user);
  }

  async getUser(id: string): Promise<User | null> {
    const [user] = await this.db.select(publicUser).from(users).where(eq(users.id, id)).limit(1);
    return user ? toPublicUser(user) : null;
  }

  async changePassword(id: string, input: PasswordChangeInput): Promise<User> {
    const passwordLength = Array.from(input.newPassword).length;
    if (passwordLength < 12 || passwordLength > 128) {
      throw new DomainError(400, 'VALIDATION_ERROR', '密码须为 12–128 个字符。', {
        newPassword: '密码须为 12–128 个字符，空格不会被移除。',
      });
    }
    const [user] = await this.db
      .select({ ...publicUser, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!user) throw new DomainError(404, 'NOT_FOUND', '账号不存在。');
    const matches = await passwordTask(() =>
      argon2.verify(user.passwordHash, input.currentPassword),
    );
    if (!matches) {
      throw new DomainError(400, 'VALIDATION_ERROR', '当前密码不正确。', {
        currentPassword: '当前密码不正确。',
      });
    }
    const passwordHash = await passwordTask(() => argon2.hash(input.newPassword, argonOptions));
    const [updated] = await this.db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, id))
      .returning(publicUser);
    if (!updated) throw new Error('Password update returned no row');
    return toPublicUser(updated);
  }
}
