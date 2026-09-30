import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

// The access token is kept in memory only (a module-level variable), never
// in localStorage/sessionStorage — this avoids XSS-based token theft via
// storage APIs. The refresh token lives in an httpOnly, Secure, SameSite
// cookie the browser sends automatically and JS can never read.
let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}
export function getAccessToken() {
  return accessToken;
}

export const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true, // send the httpOnly refresh cookie on /auth/refresh
});

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (accessToken) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

let refreshPromise: Promise<string | null> | null = null;

async function attemptRefresh(): Promise<string | null> {
  try {
    const res = await axios.post(
      `${API_BASE_URL}/auth/refresh`,
      {},
      { withCredentials: true }
    );
    const newToken = res.data?.data?.accessToken as string | undefined;
    setAccessToken(newToken || null);
    return newToken || null;
  } catch {
    setAccessToken(null);
    return null;
  }
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as (InternalAxiosRequestConfig & { _retry?: boolean }) | undefined;

    const isAuthEndpointThatShouldNotRetry =
      original?.url?.includes('/auth/login') ||
      original?.url?.includes('/auth/refresh') ||
      original?.url?.includes('/auth/register');

    if (error.response?.status === 401 && original && !original._retry && !isAuthEndpointThatShouldNotRetry) {
      original._retry = true;
      // De-dupe concurrent refresh attempts triggered by parallel requests.
      if (!refreshPromise) refreshPromise = attemptRefresh().finally(() => (refreshPromise = null));
      const newToken = await refreshPromise;
      if (newToken) {
        original.headers = original.headers || {};
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      }
    }
    return Promise.reject(error);
  }
);

export function extractErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (axios.isAxiosError(err)) {
    const msg = (err.response?.data as { message?: string } | undefined)?.message;
    if (msg) return msg;
  }
  return fallback;
}

/**
 * Like extractErrorMessage, but also understands failed downloads. With responseType 'blob',
 * axios hands the JSON error body back as a Blob, so the server's real message would otherwise be
 * lost and the user would only ever see a generic fallback.
 */
export async function extractDownloadErrorMessage(err: unknown, fallback: string): Promise<string> {
  if (axios.isAxiosError(err)) {
    const data: unknown = err.response?.data;
    if (data instanceof Blob) {
      try {
        const parsed = JSON.parse(await data.text()) as { message?: string };
        if (parsed?.message) return parsed.message;
      } catch {
        /* not JSON — fall through */
      }
      return fallback;
    }
  }
  return extractErrorMessage(err, fallback);
}

/** Hands a Blob to the browser as a file download. */
export function saveBlobAsFile(blob: Blob, filename: string): void {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Some browsers (notably Safari/iOS) start the download asynchronously; revoking immediately can cancel it.
  setTimeout(() => window.URL.revokeObjectURL(url), 10_000);
}
