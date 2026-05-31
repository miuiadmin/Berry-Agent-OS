import { createConnection } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';

const berryHome = join(homedir(), '.berry');
const dbPath = join(berryHome, 'data', 'berry.db');
const db = new Database(dbPath, { readonly: true });

const tasks = db.prepare(`
  SELECT id, status, target_agent, output_payload
  FROM agent_tasks
  WHERE task_type = 'skill_test'
  ORDER BY created_at DESC
  LIMIT 5
`).all() as Array<{id: string; status: string; target_agent: string; output_payload: string}>;

console.log(`=== skill_test 任务结果 (共 ${tasks.length} 个) ===\n`);

for (const task of tasks) {
  console.log(`任务 ${task.id}:`);
  console.log(`  状态: ${task.status}`);
  console.log(`  智能体: ${task.target_agent}`);
  if (task.output_payload) {
    const output = JSON.parse(task.output_payload);
    console.log(`  结果: ${JSON.stringify(output, null, 4)}`);
  }
  console.log();
}

db.close();
