import type { AuthInput, Session, User } from '@hcl/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});
export function cancelled(): DOMException {
  return new DOMException('Identity changed', 'AbortError');
}
export function isCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请重试。';
}
export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return '/';
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}
export type ApiOptions = RequestInit & { json?: unknown; idempotencyKey?: string };
interface AuthContextValue {
  user: User | null;
  loading: boolean;
  error: unknown;
  epoch: React.RefObject<number>;
  request: <T>(path: string, options?: ApiOptions) => Promise<T>;
  authenticate: (kind: 'login' | 'register', input: AuthInput) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  applySession: (session: Session) => void;
}
const AuthContext = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const epoch = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const refreshing = useRef<Promise<void> | null>(null);
  const changeIdentity = useCallback((next: Session | null) => {
    epoch.current++;
    sessionRef.current = next;
    // Clear all personalized entry snapshots too: public lists contain likedByMe/permissions.
    void queryClient.cancelQueries();
    queryClient.clear();
    setSession(next);
  }, []);
  const request = useCallback(
    async <T,>(path: string, options: ApiOptions = {}): Promise<T> => {
      const captured = epoch.current;
      const { json, idempotencyKey, ...init } = options;
      const headers = new Headers(init.headers);
      if (json !== undefined) headers.set('Content-Type', 'application/json');
      if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
      if (!['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase())) {
        const token = sessionRef.current?.csrfToken;
        if (token) headers.set('X-CSRF-Token', token);
      }
      const response = await fetch(path, {
        ...init,
        headers,
        credentials: 'include',
        body: json !== undefined ? JSON.stringify(json) : init.body,
      });
      if (captured !== epoch.current) throw cancelled();
      const body: unknown = response.status === 204 ? undefined : await response.json();
      if (captured !== epoch.current) throw cancelled();
      if (!response.ok) {
        const payload = body as {
          error?: { code?: string; message?: string; fields?: Record<string, string> };
        };
        if (response.status === 401) changeIdentity(null);
        throw new ApiError(
          response.status,
          payload.error?.code ?? 'REQUEST_FAILED',
          payload.error?.message ?? '请求失败，请重试。',
          payload.error?.fields,
        );
      }
      return body as T;
    },
    [changeIdentity],
  );
  const refresh = useCallback((): Promise<void> => {
    if (refreshing.current) return refreshing.current;
    const captured = epoch.current;
    setLoading(true);
    setError(null);
    refreshing.current = (async () => {
      try {
        const next = await request<Session>('/api/v1/auth/session');
        if (captured !== epoch.current) return;
        if (sessionRef.current?.user?.id !== next.user?.id) changeIdentity(next);
        else {
          sessionRef.current = next;
          setSession(next);
        }
      } catch (cause) {
        if (captured === epoch.current && !isCancelled(cause)) setError(cause);
      } finally {
        refreshing.current = null;
        setLoading(false);
      }
    })();
    return refreshing.current;
  }, [request, changeIdentity]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const authenticate = useCallback(
    async (kind: 'login' | 'register', input: AuthInput) => {
      if (!sessionRef.current) await refresh();
      const captured = epoch.current;
      const next = await request<Session>(`/api/v1/auth/${kind}`, { method: 'POST', json: input });
      if (captured !== epoch.current) throw cancelled();
      changeIdentity(next);
      setLoading(false);
    },
    [request, changeIdentity, refresh],
  );
  const logout = useCallback(async () => {
    await request<void>('/api/v1/auth/logout', { method: 'POST' });
    changeIdentity(null);
    setLoading(false);
    await refresh();
  }, [request, changeIdentity, refresh]);
  const applySession = useCallback(
    (next: Session) => {
      changeIdentity(next);
      setLoading(false);
    },
    [changeIdentity],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider
        value={{
          user: session?.user ?? null,
          loading,
          error,
          epoch,
          request,
          authenticate,
          logout,
          refresh,
          applySession,
        }}
      >
        {children}
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider is required');
  return value;
}
export async function invalidateEntries(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['entries'] });
}
