import { spawn } from 'node:child_process';
import { loginCodeResponseSchema } from '@jerry/contracts';
import { readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';

/**
 * Opens the dashboard: asks Core for a one-time login link (valid 60 s, single use) and hands it
 * to the default browser, which exchanges it for a session cookie. The CLI token never reaches
 * the browser.
 */
export async function openDashboard(options: { printOnly: boolean }): Promise<void> {
  const info = readCoreRuntimeInfo(resolveJerryHome());
  const login = loginCodeResponseSchema.parse(await requestCore(info, { method: 'POST', path: '/api/v1/ui/login-codes', body: {}, timeoutMs: 5000 }));
  if (options.printOnly) {
    console.log(login.url);
    return;
  }
  openInBrowser(login.url);
  console.log(`Opened the JERRY dashboard at ${new URL(login.url).origin} (the login link works once and expires in 60 s).`);
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(command, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
