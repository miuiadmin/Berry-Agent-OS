#!/usr/bin/env node

/**
 * 模块边界检查：确保各模块只依赖允许的模块。
 * 规则定义在 BOUNDARY_RULES 中。
 * 运行: node scripts/check-boundaries.js
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(__dirname, '..', 'src');

// 模块 → 允许依赖的模块列表
// 'self' 表示允许同模块内引用
// 外部包（node:*, @anthropic-ai/sdk, better-sqlite3 等）不检查
const BOUNDARY_RULES = {
  'contracts': ['self'],
  'utils': ['self'],
  'observability': ['self', 'utils'],
  'evolution': ['self', 'contracts', 'utils', 'skills', 'plugins'],
  'skills': ['self', 'utils'],
  'plugins': ['self', 'utils', 'skills', 'tools/types'],
  'testing': ['self', 'contracts', 'kernel', 'memory', 'utils'],
  'safety': ['self', 'contracts', 'utils'],
  'memory': ['self', 'contracts', 'utils', 'kernel/config', 'llm/client'],
  'llm': ['self', 'contracts', 'utils', 'tools/types', 'tools/index', 'kernel/ipc', 'kernel/types', 'kernel/event-bus'],
  'tools': ['self', 'contracts', 'utils', 'safety', 'kernel/ipc', 'kernel/types', 'skills'],
  'kernel': ['self', 'contracts', 'utils', 'safety', 'memory', 'evolution', 'llm', 'tools', 'testing', 'agents', 'skills', 'plugins'],
  'agents': ['self', 'contracts', 'kernel', 'llm', 'tools', 'utils', 'memory/db', 'evolution', 'code'],
  'cli': ['self', 'utils', 'kernel', 'observability', 'testing/hermetic-env', 'memory', 'evolution', 'skills', 'plugins'],
};

function getModule(filePath) {
  const rel = relative(srcDir, filePath);
  const parts = rel.split('/');
  return parts[0];
}

function getImportTarget(importPath, sourceFile) {
  if (importPath.startsWith('.')) {
    const resolved = resolve(dirname(sourceFile), importPath).replace(/\.js$/, '.ts');
    const rel = relative(srcDir, resolved);
    return rel;
  }
  return null; // external package
}

function checkFile(filePath) {
  const violations = [];
  const sourceModule = getModule(filePath);
  const rules = BOUNDARY_RULES[sourceModule];
  if (!rules) return violations;

  const content = readFileSync(filePath, 'utf-8');
  const importRegex = /import\s+.*?from\s+['"]([^'"]+)['"]/g;
  let match;

  while ((match = importRegex.exec(content)) !== null) {
    const importPath = match[1];
    if (!importPath.startsWith('.')) continue; // skip external packages

    const target = getImportTarget(importPath, filePath);
    if (!target) continue;

    const targetModule = target.split('/')[0];

    if (targetModule === sourceModule) continue; // self reference

    // Check if this specific import is allowed
    let allowed = false;
    for (const rule of rules) {
      if (rule === 'self') continue;
      if (rule === targetModule) { allowed = true; break; }
      // Allow sub-path rules like 'kernel/config'
      if (target.startsWith(rule.replace(/\//g, '/'))) { allowed = true; break; }
    }

    if (!allowed) {
      const rel = relative(srcDir, filePath);
      violations.push({
        file: rel,
        import: importPath,
        source: sourceModule,
        target: targetModule,
        targetPath: target,
      });
    }
  }

  return violations;
}

function walkDir(dir) {
  const files = [];
  const stack = [dir];
  
  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = readdirSync(currentDir);
    
    for (const entry of entries) {
      const fullPath = resolve(currentDir, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        stack.push(fullPath);
      } else if (fullPath.endsWith('.ts') && !fullPath.endsWith('.d.ts') && !fullPath.endsWith('.test.ts')) {
        files.push(fullPath);
      }
    }
  }
  
  return files;
}

const files = walkDir(srcDir);
const allViolations = [];

for (const file of files) {
  allViolations.push(...checkFile(file));
}

if (allViolations.length === 0) {
  console.log('✓ 模块边界检查通过，无违规引用');
  process.exit(0);
} else {
  console.error(`✗ 发现 ${allViolations.length} 处模块边界违规:\n`);
  for (const v of allViolations) {
    console.error(`  ${v.file}: ${v.source} → ${v.target} (${v.import})`);
  }
  process.exit(1);
}