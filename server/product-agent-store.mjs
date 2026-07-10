import crypto from 'node:crypto';

const text = (value) => String(value ?? '').trim();
const json = (value) => JSON.stringify(value && typeof value === 'object' ? value : {});
function parse(value, fallback = {}) {
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

export function ensureProductAgentTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_threads (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
      customer_id TEXT, thread_type TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_agent_threads_owner ON agent_threads(tenant_id, user_id, customer_id, updated_at);
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, tool_name TEXT, tool_result_ref TEXT,
      created_at TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages(tenant_id, thread_id, created_at, id);
    CREATE TABLE IF NOT EXISTS agent_task_states (
      thread_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, task_type TEXT NOT NULL,
      stage TEXT NOT NULL, goal_json TEXT NOT NULL DEFAULT '{}', confirmed_facts_json TEXT NOT NULL DEFAULT '{}',
      candidate_products_json TEXT NOT NULL DEFAULT '[]', excluded_products_json TEXT NOT NULL DEFAULT '[]',
      pending_questions_json TEXT NOT NULL DEFAULT '[]', last_checkpoint_at TEXT NOT NULL,
      state_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS agent_summaries (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      summary_json TEXT NOT NULL, source_message_ids_json TEXT NOT NULL,
      summary_version TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, customer_id TEXT,
      memory_type TEXT NOT NULL, content_json TEXT NOT NULL, source_message_ids_json TEXT NOT NULL,
      source_type TEXT NOT NULL, status TEXT NOT NULL, valid_from TEXT, valid_to TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_agent_memories_scope ON agent_memories(tenant_id, user_id, customer_id, status);
    CREATE TABLE IF NOT EXISTS agent_memory_events (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, memory_id TEXT NOT NULL,
      from_status TEXT, to_status TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT,
      created_at TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(memory_id) REFERENCES agent_memories(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS recommendation_runs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      status TEXT NOT NULL, request_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
      response_json TEXT NOT NULL, validation_json TEXT NOT NULL,
      model_version TEXT, prompt_version TEXT, created_at TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE
    );
  `);
}

function threadRow(row) {
  return row && { id: row.id, tenantId: row.tenant_id, userId: row.user_id, customerId: text(row.customer_id), threadType: row.thread_type, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, payload: parse(row.payload) };
}
function messageRow(row) {
  return row && { id: row.id, tenantId: row.tenant_id, threadId: row.thread_id, role: row.role, content: row.content, toolName: text(row.tool_name), toolResultRef: text(row.tool_result_ref), createdAt: row.created_at, payload: parse(row.payload) };
}
function stateRow(row) {
  return row && { threadId: row.thread_id, tenantId: row.tenant_id, taskType: row.task_type, stage: row.stage, goal: parse(row.goal_json), confirmedFacts: parse(row.confirmed_facts_json), candidateProducts: parse(row.candidate_products_json, []), excludedProducts: parse(row.excluded_products_json, []), pendingQuestions: parse(row.pending_questions_json, []), lastCheckpointAt: row.last_checkpoint_at, stateVersion: Number(row.state_version), payload: parse(row.payload) };
}
function memoryRow(row) {
  return row && { id: row.id, tenantId: row.tenant_id, userId: row.user_id, customerId: text(row.customer_id), memoryType: row.memory_type, content: parse(row.content_json), sourceMessageIds: parse(row.source_message_ids_json, []), sourceType: row.source_type, status: row.status, validFrom: text(row.valid_from), validTo: text(row.valid_to), createdAt: row.created_at, updatedAt: row.updated_at, payload: parse(row.payload) };
}

export function createProductAgentStore(db) {
  ensureProductAgentTables(db);
  function getThread({ tenantId, userId, threadId } = {}) {
    return threadRow(db.prepare('SELECT * FROM agent_threads WHERE tenant_id=? AND user_id=? AND id=?').get(text(tenantId), text(userId), text(threadId)));
  }
  function createThread(input = {}) {
    const tenantId = text(input.tenantId); const userId = text(input.userId);
    if (!tenantId || !userId) throw new Error('Agent thread requires tenant and user');
    const id = `ath_${crypto.randomUUID()}`; const now = text(input.now) || new Date().toISOString();
    db.prepare("INSERT INTO agent_threads VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)").run(id, tenantId, userId, text(input.customerId) || null, text(input.threadType) || 'product_sales', now, now, json(input.payload));
    return getThread({ tenantId, userId, threadId: id });
  }
  function appendMessage(input = {}) {
    const thread = getThread(input); const role = text(input.role); const content = text(input.content);
    if (!thread) return null;
    if (!['user', 'assistant', 'system', 'tool'].includes(role) || !content) throw new Error('Agent message requires valid role and content');
    const id = `amsg_${crypto.randomUUID()}`; const now = text(input.now) || new Date().toISOString();
    db.prepare('INSERT INTO agent_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, thread.tenantId, thread.id, role, content, text(input.toolName) || null, text(input.toolResultRef) || null, now, json(input.payload));
    db.prepare('UPDATE agent_threads SET updated_at=? WHERE id=?').run(now, thread.id);
    return messageRow(db.prepare('SELECT * FROM agent_messages WHERE id=?').get(id));
  }
  function listMessages(input = {}) {
    if (!getThread(input)) return [];
    const limit = Math.max(1, Math.min(500, Number(input.limit || 100)));
    return db.prepare('SELECT * FROM agent_messages WHERE tenant_id=? AND thread_id=? ORDER BY created_at ASC, rowid ASC LIMIT ?').all(text(input.tenantId), text(input.threadId), limit).map(messageRow);
  }
  function getTaskState(input = {}) {
    if (!getThread(input)) return null;
    return stateRow(db.prepare('SELECT * FROM agent_task_states WHERE tenant_id=? AND thread_id=?').get(text(input.tenantId), text(input.threadId)));
  }
  function saveTaskState(input = {}) {
    if (!getThread(input)) return null;
    const current = getTaskState(input); const expected = input.expectedVersion == null ? current?.stateVersion : Number(input.expectedVersion);
    if (current && expected !== current.stateVersion) { const error = new Error('任务状态已被更新'); error.code = 'AGENT_STATE_VERSION_CONFLICT'; error.status = 409; throw error; }
    const version = (current?.stateVersion || 0) + 1; const now = text(input.now) || new Date().toISOString();
    const next = { taskType: text(input.taskType) || current?.taskType || 'product_sales', stage: text(input.stage) || current?.stage || 'collecting_needs', goal: input.goal ?? current?.goal ?? {}, confirmedFacts: input.confirmedFacts ?? current?.confirmedFacts ?? {}, candidateProducts: input.candidateProducts ?? current?.candidateProducts ?? [], excludedProducts: input.excludedProducts ?? current?.excludedProducts ?? [], pendingQuestions: input.pendingQuestions ?? current?.pendingQuestions ?? [], payload: { ...(current?.payload || {}), ...(input.payload || {}) } };
    db.prepare(`INSERT INTO agent_task_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET task_type=excluded.task_type,stage=excluded.stage,goal_json=excluded.goal_json,confirmed_facts_json=excluded.confirmed_facts_json,candidate_products_json=excluded.candidate_products_json,excluded_products_json=excluded.excluded_products_json,pending_questions_json=excluded.pending_questions_json,last_checkpoint_at=excluded.last_checkpoint_at,state_version=excluded.state_version,payload=excluded.payload`).run(text(input.threadId), text(input.tenantId), next.taskType, next.stage, json(next.goal), json(next.confirmedFacts), JSON.stringify(next.candidateProducts), JSON.stringify(next.excludedProducts), JSON.stringify(next.pendingQuestions), now, version, json(next.payload));
    return getTaskState(input);
  }
  function createMemory(input = {}) {
    const id = `amem_${crypto.randomUUID()}`; const now = text(input.now) || new Date().toISOString();
    db.prepare('INSERT INTO agent_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, text(input.tenantId), text(input.userId), text(input.customerId) || null, text(input.memoryType), json(input.content), JSON.stringify(input.sourceMessageIds || []), text(input.sourceType), 'candidate', text(input.validFrom) || null, text(input.validTo) || null, now, now, json(input.payload));
    db.prepare('INSERT INTO agent_memory_events VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)').run(`amev_${crypto.randomUUID()}`, text(input.tenantId), id, 'candidate', text(input.actor) || 'system', text(input.reason), now, '{}');
    return memoryRow(db.prepare('SELECT * FROM agent_memories WHERE id=?').get(id));
  }
  function transitionMemory(input = {}) {
    const row = db.prepare('SELECT * FROM agent_memories WHERE id=? AND tenant_id=? AND user_id=?').get(text(input.memoryId), text(input.tenantId), text(input.userId));
    if (!row) return null; const from = row.status; const to = text(input.status); const now = text(input.now) || new Date().toISOString();
    db.prepare('UPDATE agent_memories SET status=?,updated_at=? WHERE id=?').run(to, now, row.id);
    db.prepare('INSERT INTO agent_memory_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(`amev_${crypto.randomUUID()}`, row.tenant_id, row.id, from, to, text(input.actor), text(input.reason), now, json(input.payload));
    return memoryRow(db.prepare('SELECT * FROM agent_memories WHERE id=?').get(row.id));
  }
  function listMemories(input = {}) {
    const params = [text(input.tenantId), text(input.userId), text(input.customerId)];
    let sql = "SELECT * FROM agent_memories WHERE tenant_id=? AND user_id=? AND COALESCE(customer_id,'')=?";
    if (text(input.status)) { sql += ' AND status=?'; params.push(text(input.status)); }
    sql += ' ORDER BY updated_at DESC, id DESC';
    return db.prepare(sql).all(...params).map(memoryRow);
  }
  function recordRecommendationRun(input = {}) {
    const id = `arun_${crypto.randomUUID()}`; const now = text(input.now) || new Date().toISOString();
    db.prepare('INSERT INTO recommendation_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, text(input.tenantId), text(input.threadId), text(input.status), json(input.request), json(input.evidence), json(input.response), json(input.validation), text(input.modelVersion), text(input.promptVersion), now, json(input.payload));
    return { id, status: text(input.status), createdAt: now };
  }
  return { appendMessage, createMemory, createThread, getTaskState, getThread, listMemories, listMessages, recordRecommendationRun, saveTaskState, transitionMemory };
}
