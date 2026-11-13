import * as http from 'node:http';

export function configureProxy(): void {
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy && !process.env.HTTP_PROXY && !process.env.http_proxy) return;
  const configure = (http as typeof http & { setGlobalProxyFromEnv?: (env: Record<string, string | undefined>) => () => void }).setGlobalProxyFromEnv;
  if (!configure) {
    throw new Error('Proxy variables are set: use Node >=24.14, or unset HTTP(S)_PROXY for a direct model connection');
  }
  const bypass = [process.env.NO_PROXY, process.env.no_proxy, 'localhost', '127.0.0.1', '::1', '[::1]'].filter(Boolean).join(',');
  configure({ ...process.env, NO_PROXY: bypass, no_proxy: bypass });
}
