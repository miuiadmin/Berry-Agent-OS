export const meta = {
  name: 'ws-dialogue-decoupling-audit',
  description: 'Audit WebSocket/frontend coupling with the dialogue system',
  phases: [
    { title: 'Map', detail: 'Map WS server, dialogue system, and their connection points' },
    { title: 'Find', detail: 'Find coupling bugs and architectural violations' },
    { title: 'Verify', detail: 'Adversarially verify each finding' },
    { title: 'Synthesize', detail: 'Synthesize findings into actionable report' },
  ],
}

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string' },
          category: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'string' },
          impact: { type: 'string' },
          suggestion: { type: 'string' }
        }
      }
    }
  }
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    findingId: { type: 'string' },
    isReal: { type: 'boolean' },
    confidence: { type: 'string' },
    actualBehavior: { type: 'string' },
    mitigatingFactors: { type: 'array', items: { type: 'string' } },
    amendedSeverity: { type: 'string' },
    amendedDescription: { type: 'string' }
  }
}

const SYNTHESIS_SCHEMA = {
  type: 'object',
  properties: {
    couplingLevel: { type: 'string' },
    confirmedIssues: { type: 'number' },
    criticalIssues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string' },
          file: { type: 'string' },
          description: { type: 'string' },
          impact: { type: 'string' }
        }
      }
    },
    architectureDefects: { type: 'array', items: { type: 'string' } },
    fixPriority: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          priority: { type: 'string' },
          action: { type: 'string' },
          effort: { type: 'string' }
        }
      }
    },
    report: { type: 'string' }
  }
}

// ── Phase 1: Map ──────────────────────────────────────────────
phase('Map')

const wsMap = await agent(
  'Explore the WebSocket server and connection management code.\n\n' +
  'Key areas:\n' +
  '1. src/web/server.ts — WS connections, lifecycle, cleanup\n' +
  '2. Any WS message routing to dialogue system\n' +
  '3. Whether dialogue state is stored in WS connection objects\n' +
  '4. What happens to in-flight dialogues when WS disconnects\n\n' +
  'Read the actual source files thoroughly. Return JSON with fields:\n' +
  'wsServerFiles (array of {path, role, keyExports}),\n' +
  'connectionLifecycle ({connect, disconnect, cleanup}),\n' +
  'wsToDialogueCoupling (array of {file, line, couplingType}),\n' +
  'dialogueStateOnWS (boolean),\n' +
  'disconnectBehavior (string)',
  { label: 'map-ws-server', phase: 'Map', schema: {
    type: 'object',
    properties: {
      wsServerFiles: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, role: { type: 'string' }, keyExports: { type: 'array', items: { type: 'string' } } } } },
      connectionLifecycle: { type: 'object', properties: { connect: { type: 'string' }, disconnect: { type: 'string' }, cleanup: { type: 'string' } } },
      wsToDialogueCoupling: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'string' }, couplingType: { type: 'string' } } } },
      dialogueStateOnWS: { type: 'boolean' },
      disconnectBehavior: { type: 'string' }
    }
  }}
)

const dialogueMap = await agent(
  'Explore the dialogue/conversation system.\n\n' +
  'Key areas:\n' +
  '1. src/contracts/dialogue.ts — dialogue contracts and types\n' +
  '2. src/kernel/ — dialogue creation, routing, completion\n' +
  '3. src/agents/ — agent runner and dialogue processing\n' +
  '4. Whether dialogue state is persisted in SQLite\n' +
  '5. How dialogue results are delivered\n' +
  '6. src/kernel/agent-runner.ts and src/kernel/task-manager.ts\n\n' +
  'Read the actual source files. Return JSON with fields:\n' +
  'dialogueFiles (array of {path, role, dependsOnWS}),\n' +
  'dialoguePersistence (string: sqlite|memory|mixed),\n' +
  'resultDelivery (string: ws_push|polling|event_bus|mixed),\n' +
  'agentRunnerCoupling (array of {file, couplingPoint, riskLevel}),\n' +
  'dialogueLifecycle ({create, execute, complete, cleanup})',
  { label: 'map-dialogue-system', phase: 'Map', schema: {
    type: 'object',
    properties: {
      dialogueFiles: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, role: { type: 'string' }, dependsOnWS: { type: 'boolean' } } } },
      dialoguePersistence: { type: 'string' },
      resultDelivery: { type: 'string' },
      agentRunnerCoupling: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, couplingPoint: { type: 'string' }, riskLevel: { type: 'string' } } } },
      dialogueLifecycle: { type: 'object', properties: { create: { type: 'string' }, execute: { type: 'string' }, complete: { type: 'string' }, cleanup: { type: 'string' } } }
    }
  }}
)

const bridgeMap = await agent(
  'Explore the bridge/adapter layer between WebSocket and dialogue.\n\n' +
  'Key areas:\n' +
  '1. src/web/api-routes.ts — HTTP API routes for dialogue\n' +
  '2. src/web/server.ts — WS message handlers\n' +
  '3. src/channels/ — message channels\n' +
  '4. Any channel abstraction separating transport from dialogue\n' +
  '5. Event bus between WS and dialogue engine\n\n' +
  'Read the actual source files. Return JSON with fields:\n' +
  'bridgeFiles (array of {path, role, couplingRisk}),\n' +
  'channelAbstraction ({exists: boolean, details}),\n' +
  'transportLayer ({ws, http, cli}),\n' +
  'eventBusUsage (array of {file, events}),\n' +
  'abstractionGaps (array of {gap, risk, file})',
  { label: 'map-bridge-layer', phase: 'Map', schema: {
    type: 'object',
    properties: {
      bridgeFiles: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, role: { type: 'string' }, couplingRisk: { type: 'string' } } } },
      channelAbstraction: { type: 'object', properties: { exists: { type: 'boolean' }, details: { type: 'string' } } },
      transportLayer: { type: 'object', properties: { ws: { type: 'string' }, http: { type: 'string' }, cli: { type: 'string' } } },
      eventBusUsage: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, events: { type: 'array', items: { type: 'string' } } } } },
      abstractionGaps: { type: 'array', items: { type: 'object', properties: { gap: { type: 'string' }, risk: { type: 'string' }, file: { type: 'string' } } } }
    }
  }}
)

const eventBusMap = await agent(
  'Explore the event bus, IPC, and notification systems.\n\n' +
  'Key areas:\n' +
  '1. src/bus/ — event/capability bus\n' +
  '2. src/kernel/agent-manager.ts — agent result delivery\n' +
  '3. src/kernel/agent-runner.ts — agent run tracking\n' +
  '4. src/intelligence/ — notification and delegation\n' +
  '5. src/scheduler/ — scheduled tasks triggering dialogues\n' +
  '6. Pub/sub patterns\n\n' +
  'Read the actual source files. Return JSON with fields:\n' +
  'eventBusFiles (array of {path, role}),\n' +
  'communicationPatterns (array of {pattern, from, to, coupling}),\n' +
  'notificationDelivery (array of {mechanism, dependsOnWS, fallback}),\n' +
  'agentResultDelivery (array of {method, wsRequired}),\n' +
  'decouplingMechanisms (array of {mechanism, coverage})',
  { label: 'map-event-bus', phase: 'Map', schema: {
    type: 'object',
    properties: {
      eventBusFiles: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, role: { type: 'string' } } } },
      communicationPatterns: { type: 'array', items: { type: 'object', properties: { pattern: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, coupling: { type: 'string' } } } },
      notificationDelivery: { type: 'array', items: { type: 'object', properties: { mechanism: { type: 'string' }, dependsOnWS: { type: 'boolean' }, fallback: { type: 'string' } } } },
      agentResultDelivery: { type: 'array', items: { type: 'object', properties: { method: { type: 'string' }, wsRequired: { type: 'boolean' } } } },
      decouplingMechanisms: { type: 'array', items: { type: 'object', properties: { mechanism: { type: 'string' }, coverage: { type: 'string' } } } }
    }
  }}
)

// ── Phase 2: Find ─────────────────────────────────────────────
phase('Find')

const f1 = await agent(
  'Deep code review of WebSocket-to-dialogue coupling.\n\n' +
  'Read these files thoroughly:\n' +
  '1. src/web/server.ts — entire WS setup, message handling, connection management\n' +
  '2. src/web/api-routes.ts — API routes for dialogue requests\n' +
  '3. src/contracts/dialogue.ts — dialogue contracts\n\n' +
  'For each file, identify:\n' +
  '- Does code pass WS connection objects into dialogue/agent functions?\n' +
  '- Does dialogue state get stored on WS connection objects?\n' +
  '- When WS disconnects, what happens to in-progress dialogue?\n' +
  '- Is there cleanup code that could cancel running dialogues on disconnect?\n' +
  '- Are there callbacks/promises that would reject when WS disconnects?\n\n' +
  'Return JSON with findings array. Each finding: {id, severity (P0|P1|P2|P3), category, file, line, description, evidence, impact, suggestion}',
  { label: 'find-ws-dialogue-coupling', phase: 'Find', schema: FINDING_SCHEMA }
)

const f2 = await agent(
  'Deep code review of agent runner and task manager coupling.\n\n' +
  'Read these files thoroughly:\n' +
  '1. src/kernel/agent-runner.ts — agent run management\n' +
  '2. src/kernel/task-manager.ts — task lifecycle\n' +
  '3. src/kernel/agent-manager.ts — agent lifecycle\n' +
  '4. src/kernel/core-service.ts or src/kernel/bootstrap.ts — core system\n\n' +
  'For each file, identify:\n' +
  '- Is the agent runner tied to any specific transport (WS/HTTP)?\n' +
  '- Does it register runs so they survive transport disconnect?\n' +
  '- Are results stored persistently or only in memory?\n' +
  '- Is there a mechanism to resume after transport reconnect?\n' +
  '- What happens if the caller (WS handler) goes away?\n\n' +
  'Return JSON with findings array. Each finding: {id, severity (P0|P1|P2|P3), category, file, line, description, evidence, impact, suggestion}',
  { label: 'find-agent-runner-coupling', phase: 'Find', schema: FINDING_SCHEMA }
)

const f3 = await agent(
  'Review notification/event delivery from dialogues to clients.\n\n' +
  'Read these files:\n' +
  '1. src/web/server.ts — WS response sending\n' +
  '2. src/bus/ — event bus\n' +
  '3. src/intelligence/ — notification services\n' +
  '4. src/channels/ — channel abstraction\n\n' +
  'Focus on:\n' +
  '- How dialogue results are delivered to clients\n' +
  '- Is delivery via WS connection.send() directly or through abstraction?\n' +
  '- If WS is gone, does the result get lost or stored?\n' +
  '- Can clients subscribe to dialogue events?\n' +
  '- Can clients reconnect and receive missed events?\n\n' +
  'Return JSON with findings array. Each finding: {id, severity (P0|P1|P2|P3), category, file, line, description, evidence, impact, suggestion}',
  { label: 'find-delivery-coupling', phase: 'Find', schema: FINDING_SCHEMA }
)

const f4 = await agent(
  'Review frontend WebSocket client code for reconnection behavior.\n\n' +
  'Read these files:\n' +
  '1. web/src/hooks/ — WebSocket hooks\n' +
  '2. web/src/lib/ — stores and API clients\n' +
  '3. Any WS connection management in frontend\n\n' +
  'Focus on:\n' +
  '- How frontend handles WS disconnection\n' +
  '- Retry/reconnect strategy and backoff\n' +
  '- Whether it resumes in-progress conversations on reconnect\n' +
  '- Whether it fetches missed messages from API or only relies on WS push\n' +
  '- Race conditions between WS reconnect and HTTP API calls\n\n' +
  'Return JSON with findings array. Each finding: {id, severity (P0|P1|P2|P3), category, file, line, description, evidence, impact, suggestion}',
  { label: 'find-frontend-ws-coupling', phase: 'Find', schema: FINDING_SCHEMA }
)

var allFindings = [
  ...(f1 && f1.findings ? f1.findings : []),
  ...(f2 && f2.findings ? f2.findings : []),
  ...(f3 && f3.findings ? f3.findings : []),
  ...(f4 && f4.findings ? f4.findings : [])
]
log('Found ' + allFindings.length + ' potential coupling issues, verifying...')

// ── Phase 3: Verify ───────────────────────────────────────────
phase('Verify')

var p0p1 = allFindings.filter(function(f) { return f.severity === 'P0' || f.severity === 'P1' })

var verified = await parallel(
  p0p1.map(function(f) {
    return function() {
      return agent(
        'Adversarial verifier. READ THE ACTUAL SOURCE CODE and verify whether this finding is real or false positive.\n\n' +
        'Finding:\n' +
        '- ID: ' + f.id + '\n' +
        '- Severity: ' + f.severity + '\n' +
        '- Category: ' + f.category + '\n' +
        '- File: ' + f.file + '\n' +
        '- Description: ' + f.description + '\n' +
        '- Evidence: ' + f.evidence + '\n\n' +
        'Steps:\n' +
        '1. Read file ' + f.file + ' and surrounding context (50+ lines)\n' +
        '2. Check if the described coupling actually exists\n' +
        '3. Consider mitigating factors (error handling, fallbacks, persistence)\n' +
        '4. Determine if WS disconnection would actually break dialogue\n' +
        '5. Rate confidence\n\n' +
        'Return JSON: {findingId, isReal (boolean), confidence (high|medium|low), actualBehavior, mitigatingFactors (string[]), amendedSeverity (P0|P1|P2|P3|dismissed), amendedDescription}',
        { label: 'verify-' + f.id, phase: 'Verify', schema: VERIFY_SCHEMA }
      )
    }
  })
)

// ── Phase 4: Synthesize ───────────────────────────────────────
phase('Synthesize')

var synthesis = await agent(
  'Senior architect reviewing WS-dialogue decoupling audit results. Write the report in Chinese.\n\n' +
  '## Architecture Map Summary\n\n' +
  '### WS Server\n' + JSON.stringify(wsMap, null, 2) + '\n\n' +
  '### Dialogue System\n' + JSON.stringify(dialogueMap, null, 2) + '\n\n' +
  '### Bridge Layer\n' + JSON.stringify(bridgeMap, null, 2) + '\n\n' +
  '### Event Bus\n' + JSON.stringify(eventBusMap, null, 2) + '\n\n' +
  '## All Findings (pre-verification)\n' + JSON.stringify(allFindings, null, 2) + '\n\n' +
  '## Verified P0/P1 Findings\n' + JSON.stringify(verified, null, 2) + '\n\n' +
  '## Task\n' +
  'Produce a final audit report in Chinese with:\n' +
  '1. **架构现状评估** — WS 与对话系统耦合程度（松耦合/中等耦合/紧耦合）\n' +
  '2. **核心问题列表** — 已验证问题，按严重程度排序（严重程度、文件位置、问题描述、实际影响）\n' +
  '3. **架构缺陷** — 系统性设计问题（不是单个 bug，而是设计层面的问题）\n' +
  '4. **修复方案** — 具体可执行的修复建议，分优先级（P0 先修、P1 再修）\n' +
  '5. **理想架构** — WS 与对话系统应有的解耦架构（用 ASCII art 画架构图）\n' +
  '6. **风险评估** — 不修复的风险\n\n' +
  'Be specific about file paths and code locations.\n\n' +
  'Return JSON: {couplingLevel, confirmedIssues (number), criticalIssues (array of {id, severity, file, description, impact}), architectureDefects (string[]), fixPriority (array of {priority, action, effort}), report (full markdown report string)}',
  { label: 'synthesize-report', phase: 'Synthesize', schema: SYNTHESIS_SCHEMA }
)

return synthesis
