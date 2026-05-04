import { spawn } from 'node:child_process';

export function makeGh({ ghToken } = {}) {
  return function gh(args, { json = true } = {}) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      if (ghToken) env.GH_TOKEN = ghToken;
      else delete env.GH_TOKEN;
      const child = spawn('gh', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`gh ${args.join(' ')} failed (${code}): ${stderr}`));
        resolve(json ? JSON.parse(stdout) : stdout);
      });
      child.on('error', reject);
    });
  };
}

export function git(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`)));
    child.on('error', reject);
  });
}
