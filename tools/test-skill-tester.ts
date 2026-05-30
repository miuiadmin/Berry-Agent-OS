import { createConnection } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';

const socketPath = join(homedir(), '.berryagent', 'run', 'berry.sock');

async function dispatch(taskType: string, inputPayload: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = JSON.stringify({
      type: 'evolution.dispatch',
      taskType,
      sessionId: `cli-e2e-${Date.now()}`,
      requester: 'cli-test',
      inputPayload,
    }) + '\n';

    const socket = createConnection(socketPath);
    let buffer = '';
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          socket.end();
          resolve(JSON.parse(line));
          return;
        }
      }
    });
    socket.on('error', reject);
    setTimeout(() => { socket.end(); reject(new Error('Timeout')); }, 15000);
  });
}

async function main() {
  console.log('=== 1. dispatch skill_test → skill-tester agent (meeting-notes) ===');
  const result1 = await dispatch('skill_test', { skillName: 'meeting-notes' });
  console.log(JSON.stringify(result1, null, 2));

  console.log('\n=== 2. dispatch skill_test → skill-tester agent (code-review with args) ===');
  const result2 = await dispatch('skill_test', { skillName: 'code-review', arguments: 'app.ts performance' });
  console.log(JSON.stringify(result2, null, 2));

  console.log('\n=== 3. dispatch skill_test → skill-tester agent (non-existent skill) ===');
  const result3 = await dispatch('skill_test', { skillName: 'does-not-exist-xyz' });
  console.log(JSON.stringify(result3, null, 2));

  // Wait for tasks to complete
  console.log('\n=== Waiting 5s for agents to finish ===');
  await new Promise(r => setTimeout(r, 5000));

  // Check task results
  console.log('\n=== 4. Check task status ===');
  const status = await dispatch('skill_test', { skillName: 'git-commit-helper', arguments: 'fix utils' });
  console.log(JSON.stringify(status, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
