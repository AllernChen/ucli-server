// Optional real-client acceptance, called by employee-key-http.mjs after its HTTP assertions.
// Only a temporary workspace and loopback mock supplier are exposed to the CLI.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import Decimal from 'decimal.js'

export async function runCliAcceptance({ base, db, key, models, groupId, requests, setUpstream }) {
  assert.equal(new URL(base).hostname, '127.0.0.1')
  const directory = await mkdtemp(join(tmpdir(), 'ucli-cli-acceptance-'))
  const project = join(directory, 'project'), fixture = join(project, 'probe.txt')
  const marker = `UCLI_TOOL_${randomUUID()}`
  await mkdir(project)
  await writeFile(fixture, marker)
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(path|systemroot|windir|comspec|temp|tmp|pathext)$/i.test(name)))
  Object.assign(env, { UCLI_API_KEY: key.secret, CLAUDE_CONFIG_DIR: join(directory, 'claude'),
    XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state'),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1024', CLAUDE_CODE_MAX_RETRIES: '0',
    MAX_THINKING_TOKENS: '0', CLAUDE_CODE_MAX_TURNS: '3', NO_COLOR: '1' })
  const results = []
  let mode = 'text', toolReturned = false
  setUpstream((req, res, body) => {
    const messages = body.messages || []
    const returned = messages.some(m => m.role === 'tool' && String(m.content).includes(marker) ||
      Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result' && JSON.stringify(c.content).includes(marker)))
    if (returned) toolReturned = true
    const tool = mode === 'tool' && !returned ? body.tools?.find(t => /^(Read|read)$/.test(t.name || t.function?.name)) : undefined
    const input = { [tool?.name === 'Read' ? 'file_path' : 'filePath']: fixture }
    const text = returned ? 'UCLI_TOOL_OK' : 'UCLI_CLI_OK'
    const id = `msg_${randomUUID()}`, callId = 'call_probe', usage = { input_tokens: 3, output_tokens: 2 }
    const anthropic = new URL(req.url, base).pathname === '/v1/messages'
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json')
    if (anthropic) {
      const content = tool ? { type: 'tool_use', id: callId, name: tool.name, input } : { type: 'text', text }
      const message = { id, type: 'message', role: 'assistant', model: body.model, content: [content], stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage }
      if (!body.stream) return res.end(JSON.stringify(message))
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } })
      event('content_block_start', { index: 0, content_block: tool ? { ...content, input: {} } : { type: 'text', text: '' } })
      event('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text } })
      event('content_block_stop', { index: 0 })
      event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 2 } })
      event('message_stop', {}); return res.end()
    }
    const toolCall = tool ? { id: callId, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(input) } } : null
    const chunk = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model }
    const tokenUsage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    if (!body.stream) return res.end(JSON.stringify({ ...chunk, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: tool ? null : text, ...(tool ? { tool_calls: [toolCall] } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: tokenUsage }))
    const send = data => res.write(`data: ${JSON.stringify({ ...chunk, ...data })}\n\n`)
    send({ choices: [{ index: 0, delta: { role: 'assistant', ...(tool ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: text }) }, finish_reason: null }] })
    send({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: tokenUsage })
    res.end('data: [DONE]\n\n')
  })
  const execute = async (name, executable, args, extra = {}) => {
    const before = requests.length; toolReturned = false
    const output = await new Promise(resolveRun => {
      const child = spawn(executable, args, { cwd: project, env: { ...env, ...extra }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = '', timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill() }, 45_000)
      child.stdout.on('data', value => { stdout += value.toString() })
      child.stderr.on('data', value => { stderr += value.toString() })
      child.once('error', error => { stderr += error.message })
      child.once('close', code => { clearTimeout(timer); resolveRun({ code, timedOut, stdout, stderr }) })
    })
    const trace = requests.slice(before)
    const logs = await db.usageLog.findMany({ where: { groupId, requestId: { in: trace.flatMap(r => r.requestId ? [String(r.requestId)] : []) } },
      select: { requestId: true, protocol: true, streaming: true, costUsd: true, errorCode: true, apiKeyId: true, groupId: true } })
    assert.ok(logs.every(log => log.apiKeyId === key.id && log.groupId === groupId))
    const events = output.stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    const reply = events.find(e => e.type === 'result')?.result || events.filter(e => e.type === 'text').map(e => e.part?.text).join('')
    const result = { name, ...output, reply, toolReturned, requests: trace, logs }
    results.push(result)
    console.log(JSON.stringify({ name, code: output.code, timedOut: output.timedOut, toolReturned, requests: trace, reply: reply || output.stdout.slice(-250), stderr: output.stderr.slice(-400) }).replaceAll(key.secret, '[REDACTED]'))
    return result
  }
  try {
    // Test fixture capacity only: real CLI envelopes are much larger than hand-written HTTP probes.
    await db.publicModel.updateMany({ where: { id: { in: models.map(m => m.id) } }, data: { contextSize: 200000 } })
    // Explicitly labelled synthetic model; never rename an actual supplier model for discovery.
    const mapping = await db.channelModel.findFirstOrThrow({ where: { publicModelId: models[2].id } })
    const group = await db.usageGroup.findUniqueOrThrow({ where: { id: groupId } })
    const discoveredModel = await db.publicModel.create({ data: { id: `claude-ucli-local-${randomUUID()}`, displayName: 'UCLI local discovery fixture', enabled: true, contextSize: 200000,
      channelModels: { create: { channelId: mapping.channelId, upstreamModel: 'ANTHROPIC_MESSAGES', protocol: 'ANTHROPIC_MESSAGES', health: 'HEALTHY' } },
      prices: { create: { inputPerMillion: '1', outputPerMillion: '2', validFrom: new Date(0) } } } })
    await db.groupModelAccess.create({ data: { organizationId: group.organizationId, groupId, publicModelId: discoveredModel.id } })
    const periodBefore = await db.groupBudgetPeriod.findFirstOrThrow({ where: { groupId } })
    const claude = process.env.UCLI_TEST_CLAUDE_EXE, opencode = process.env.UCLI_TEST_OPENCODE_EXE
    assert.ok(claude && opencode, 'Explicit installed CLI executable paths required')
    const claudeEnv = { ANTHROPIC_BASE_URL: `${base}/anthropic`, ANTHROPIC_API_KEY: key.secret, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' }
    const flags = ['--bare', '--strict-mcp-config', '--no-session-persistence', '--model', discoveredModel.id, '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
    await execute('claude-version', claude, ['--version'])
    mode = 'text'
    const defaultCache = await execute('claude-default-cache', claude, [...flags, '--tools', '', '-p', 'Reply UCLI_CLI_OK only.'], claudeEnv)
    const chat = await execute('claude-text-cache-off', claude, [...flags, '--tools', '', '-p', 'Reply UCLI_CLI_OK only.'], { ...claudeEnv, DISABLE_PROMPT_CACHING: '1' })
    mode = 'tool'
    const tools = await execute('claude-read-tool-cache-off', claude, [...flags, '--tools', 'Read', '--allowedTools', 'Read', '-p', `Read ${fixture} then reply UCLI_TOOL_OK.`], { ...claudeEnv, DISABLE_PROMPT_CACHING: '1' })
    mode = 'text'
    const discovery = await execute('claude-discovery-probe', claude, [...flags.filter(f => f !== '--bare'), '--safe-mode', '--setting-sources', '', '--tools', '', '-p', '/model'], { ...claudeEnv, DISABLE_PROMPT_CACHING: '1' })
    // Headless /model verifies startup discovery and the local command, not the interactive picker UI.
    assert.ok(discovery.code === 0 && discovery.reply.includes(discoveredModel.id) && discovery.requests.some(r => r.path === '/anthropic/v1/models' && r.status === 200), 'Claude must request the real gateway directory')
    const config = { enabled_providers: ['ucli'], autoupdate: false, share: 'disabled', permission: { '*': 'deny', read: 'allow' },
      provider: { ucli: { npm: '@ai-sdk/openai-compatible', name: 'UCLI local acceptance', options: { baseURL: `${base}/v1`, apiKey: '{env:UCLI_API_KEY}' },
        models: { [models[0].id]: { name: 'Local mock Chat', limit: { context: 200000, output: 1024 } } } } },
      model: `ucli/${models[0].id}`, small_model: `ucli/${models[0].id}` }
    const openEnv = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
    await execute('opencode-version', opencode, ['--version'], openEnv)
    const openModels = await execute('opencode-models', opencode, ['models', 'ucli'], openEnv)
    assert.ok(openModels.code === 0 && openModels.stdout.includes(config.model), 'OpenCode must list the configured model')
    mode = 'text'
    const openChat = await execute('opencode-text', opencode, ['run', '--pure', '--format', 'json', '-m', config.model, 'Reply UCLI_CLI_OK only.'], openEnv)
    mode = 'tool'
    const openTools = await execute('opencode-read-tool', opencode, ['run', '--pure', '--format', 'json', '-m', config.model, `Read ${fixture} then reply UCLI_TOOL_OK.`], openEnv)
    assert.ok(chat.reply === 'UCLI_CLI_OK' && chat.logs.length && chat.code === 0, 'Claude text acceptance failed')
    assert.ok(defaultCache.requests.some(r => r.status === 400) && defaultCache.logs.length === 0, 'Unpriced cache writes must remain rejected')
    assert.ok(tools.toolReturned && tools.reply === 'UCLI_TOOL_OK' && tools.code === 0, 'Claude tool roundtrip failed')
    assert.ok(openChat.reply === 'UCLI_CLI_OK' && openChat.logs.length && openChat.code === 0, 'OpenCode text acceptance failed')
    assert.ok(openTools.toolReturned && openTools.reply === 'UCLI_TOOL_OK' && openTools.code === 0, 'OpenCode tool roundtrip failed')
    const logs = results.flatMap(r => r.logs)
    assert.ok(logs.every(log => log.costUsd.toFixed(8) === '0.00000700' && !log.errorCode), 'CLI cost snapshots must use the configured CNY supplier price')
    const periodAfter = await db.groupBudgetPeriod.findUniqueOrThrow({ where: { id: periodBefore.id } })
    assert.equal(periodAfter.spentCny.minus(periodBefore.spentCny).toFixed(8), new Decimal('0.000007').mul(logs.length).toFixed(8))
    if (process.env.UCLI_TEST_INTERACTIVE === '1') {
      assert.ok(process.stdin.isTTY && process.stdout.isTTY, 'Interactive acceptance requires a real terminal')
      mode = 'text'
      for (const [name, executable, args, extra] of [
        ['claude-picker', claude, ['--safe-mode', '--setting-sources', '', '--strict-mcp-config', '--tools', '', '--model', discoveredModel.id], { ...claudeEnv, DISABLE_PROMPT_CACHING: '1' }],
        ['opencode-picker', opencode, ['--pure', '-m', config.model], openEnv]
      ]) {
        const before = requests.length
        console.log(`\nInteractive acceptance: ${name}. Open /model (Claude) or /models (OpenCode), then /exit.\n`)
        const code = await new Promise((resolveExit, rejectExit) => {
          const child = spawn(executable, args, { cwd: project, env: { ...env, ...extra }, windowsHide: true, stdio: 'inherit' })
          child.once('error', rejectExit); child.once('exit', resolveExit)
        })
        results.push({ name, code, requests: requests.slice(before), visualAcceptance: 'Record observed terminal evidence separately' })
        assert.equal(code, 0, `${name} exited unsuccessfully; interactive acceptance is incomplete`)
      }
    }
  } finally {
    setUpstream(undefined)
    // Disable even on assertion/CLI failures; the parent subsequently tests permanent revocation.
    await db.employeeApiKey.update({ where: { id: key.id }, data: { disabledAt: new Date() } })
    const report = resolve('data/employee-cli-acceptance.json')
    await mkdir(dirname(report), { recursive: true })
    await writeFile(report, JSON.stringify({ at: new Date().toISOString(), results }, null, 2).replaceAll(key.secret, '[REDACTED]'))
    console.log(`CLI evidence: ${report}`)
    assert.equal(dirname(directory), resolve(tmpdir())); assert.ok(basename(directory).startsWith('ucli-cli-acceptance-'))
    await rm(directory, { recursive: true, force: true })
  }
}
