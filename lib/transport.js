import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bootstrap = fileURLToPath(new URL('./runner.py', import.meta.url));

// Never give a host shell model input. Credentials and arguments use stdin,
// not argv, so they are absent from the process command line.
export function runHelper(payload, { cwd, signal, timeout = 95_000, maxBytes = 4_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('OpenKapsel request cancelled'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('OPENKAPSEL_') && !key.startsWith('PYTHON')));
    const child = spawn(process.platform === 'win32' ? 'python' : 'python3',
      ['-I', '-B', bootstrap], { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let failure;
    const stop = (reason) => { failure ??= reason; child.kill('SIGKILL'); };
    const abort = () => stop('OpenKapsel request cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('OpenKapsel request timed out'), timeout);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) stop('OpenKapsel response exceeded the output limit; request a smaller page');
      else chunks.push(chunk);
    });
    // Python returns a sanitized error envelope on stdout. Do not echo raw
    // stderr, which may include local paths, URLs, or server-supplied secrets.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { failure = 'Unable to start Python; install Python 3.10+ on PATH'; });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) return reject(new Error(failure));
      try {
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (code !== 0 || envelope.error) throw new Error(envelope.error || 'OpenKapsel helper failed');
        resolve(envelope.result);
      } catch (error) {
        reject(new Error(error instanceof SyntaxError ? 'OpenKapsel helper returned an invalid response' : error.message));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
