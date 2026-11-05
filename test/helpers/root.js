import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Creates a throwaway config root. When `config` is given it is serialized to
 * `<root>/config.json`, mimicking a user-level configuration file.
 */
export function makeRoot(t, config) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aqs-test-'));
  if (config !== undefined) {
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Resolves once the server is listening on an ephemeral port and returns its base URL. */
export async function listenEphemeral(server) {
  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

/** Closes an HTTP server, dropping keep-alive sockets first. */
export async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
