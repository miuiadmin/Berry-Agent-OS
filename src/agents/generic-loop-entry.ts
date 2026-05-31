import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { startGenericAgent, type GenericAgentConfig } from './generic-loop.js';
import { scanAgentYaml } from '../bus/security-scanner.js';

const configPath = process.env.GENERIC_AGENT_CONFIG;
if (!configPath) {
  throw new Error('GENERIC_AGENT_CONFIG environment variable not set');
}

const raw = readFileSync(configPath, 'utf-8');
const manifest = configPath.endsWith('.yaml') || configPath.endsWith('.yml')
  ? parseYaml(raw)
  : JSON.parse(raw);

// §4.3 Security scan: prevent prompt injection in dynamic agent YAML
const scanResult = scanAgentYaml({
  name: manifest.name,
  system_prompt: manifest.systemPrompt ?? manifest.system_prompt,
  capabilities_required: manifest.capabilitiesRequired ?? manifest.capabilities_required,
});
if (!scanResult.safe) {
  throw new Error(`Security scan failed for agent "${manifest.name}": ${scanResult.blockers.join('; ')}`);
}

const config: GenericAgentConfig = {
  name: manifest.name,
  systemPrompt: manifest.systemPrompt ?? manifest.system_prompt ?? `You are ${manifest.name}. ${manifest.description}`,
  capabilitiesProvided: manifest.capabilitiesProvided ?? manifest.capabilities_provided ?? [],
  capabilitiesRequired: manifest.capabilitiesRequired ?? manifest.capabilities_required ?? [],
  modelTier: manifest.modelTier ?? manifest.model_tier ?? 'default',
  maxTurns: manifest.maxTurns ?? manifest.max_turns ?? 10,
  temperature: manifest.temperature ?? 0.3,
};

startGenericAgent(config);
