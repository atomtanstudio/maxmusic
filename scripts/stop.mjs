import { execSync } from 'node:child_process';

const PORT = Number(process.env.PORT) || 3000;

try {
  const pids = execSync(`lsof -ti :${PORT}`, { encoding: 'utf8' }).trim();
  if (!pids) {
    console.log(`No process on port ${PORT}.`);
    process.exit(0);
  }
  for (const pid of pids.split('\n').filter(Boolean)) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  console.log(`Stopped process(es) on port ${PORT}.`);
} catch {
  console.log(`No process on port ${PORT}.`);
}