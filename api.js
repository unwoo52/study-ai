import {
  QUICK_REASON_SCHEMA, QUICK_REASON_SYSTEM, QUICK_REQUEST, QUICK_SCHEMA, QUICK_SYSTEM,
  SOLVE_REQUEST, SOLVE_SCHEMA, SOLVE_SYSTEM, WEB_SYSTEM, webRequest,
} from './prompt.js';

// 달러 / 100만 토큰. 가격이 바뀌면 여기만 고친다.
export const MODELS = {
  'claude-opus-5-5': { label: 'Opus 5.5 (가장 정확)', input: 4, output: 20, fallbacks: true },
  'claude-sonnet-5-5': { label: 'Sonnet 5.5 (균형)', input: 2, output: 10, fallbacks: true },
  'claude-haiku-5-5': { label: 'Haiku 5.5 (가장 저렴)', input: 0.1, output: 0.5, fallbacks: false },
};

// 빠른 답은 설정의 모델과 상관없이 가장 빠르고 저렴한 모델을 쓴다.
export const QUICK_MODEL = 'claude-haiku-5-5';

// 빠른 답 성능 단계. 위로 갈수록 빠르고 아래로 갈수록 정확하다.
export const QUICK_LEVELS = {
  instant: {
    label: '즉답',
    detail: '(가장 빠름)',
    system: QUICK_SYSTEM,
    schema: QUICK_SCHEMA,
    maxTokens: 128,
    thinking: { type: 'disabled' },
  },
  brief: {
    label: '짧은 추론',
    detail: '(균형, 비용 약 2배)',
    system: QUICK_REASON_SYSTEM,
    schema: QUICK_REASON_SCHEMA,
    maxTokens: 500,
    thinking: { type: 'disabled' },
  },
  thinking: {
    label: '생각 켜기',
    detail: '(가장 정확, 비용 약 3배, 5초 넘을 수 있음)',
    system: QUICK_REASON_SYSTEM,
    schema: QUICK_REASON_SCHEMA,
    maxTokens: 1500,
  },
};

const WEB_SEARCH_PRICE = 0.01;
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 180000;
const QUICK_TIMEOUT_MS = 20000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function costOf(usage, model) {
  const price = MODELS[model] ?? MODELS['claude-opus-5-5'];
  return (usage.input * price.input + usage.output * price.output) / 1e6 + usage.searches * WEB_SEARCH_PRICE;
}

function readUsage(data) {
  const usage = data.usage ?? {};
  return {
    input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    output: usage.output_tokens ?? 0,
    searches: usage.server_tool_use?.web_search_requests ?? 0,
  };
}

function friendlyError(status, message) {
  if (status === 401) return 'API 키가 올바르지 않아요. 설정에서 확인해 주세요.';
  if (/credit balance/i.test(message)) return 'API 크레딧 잔액이 부족해요. 충전 후 다시 시도해 주세요.';
  return `API 오류 ${status}: ${message}`;
}

async function callClaude(body, apiKey, { attempts = MAX_ATTEMPTS, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const payload = { ...body };
  if (MODELS[body.model]?.fallbacks) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    payload.fallbacks = 'default';
  }

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await wait(lastError.delay);
    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = Object.assign(new Error(`네트워크 오류: ${error.message}`), { delay: 2000 * 2 ** attempt });
      continue;
    }
    if (response.ok) return response.json();

    const detail = await response.json().catch(() => null);
    const error = new Error(friendlyError(response.status, detail?.error?.message ?? response.statusText));
    if (response.status !== 429 && response.status < 500) throw error;
    const retryAfter = Number(response.headers.get('retry-after'));
    error.delay = retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
    lastError = error;
  }
  throw lastError;
}

function checkStop(data) {
  if (data.stop_reason === 'refusal') throw new Error('Claude가 이 요청을 거절했어요.');
  if (data.stop_reason === 'max_tokens') throw new Error('답변이 너무 길어서 잘렸어요. 다시 시도해 주세요.');
}

const textOf = (content) => content.filter((block) => block.type === 'text').map((block) => block.text).join('');

const photoMessage = (imageBase64, request) => ({
  role: 'user',
  content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
    { type: 'text', text: request },
  ],
});

// 늦어지면 의미가 없어서 재시도도 한 번만 한다.
export async function quickSolve(imageBase64, apiKey, levelId) {
  const level = QUICK_LEVELS[levelId];
  const data = await callClaude({
    model: QUICK_MODEL,
    max_tokens: level.maxTokens,
    system: level.system,
    ...(level.thinking && { thinking: level.thinking }),
    output_config: { effort: 'low', format: { type: 'json_schema', schema: level.schema } },
    messages: [photoMessage(imageBase64, QUICK_REQUEST)],
  }, apiKey, { attempts: 2, timeoutMs: QUICK_TIMEOUT_MS });
  checkStop(data);
  return {
    result: JSON.parse(textOf(data.content)),
    usage: readUsage(data),
    model: data.model ?? QUICK_MODEL,
    level: levelId,
  };
}

export async function solve(imageBase64, { apiKey, model, effort }) {
  const data = await callClaude({
    model,
    max_tokens: 16000,
    system: SOLVE_SYSTEM,
    output_config: { effort, format: { type: 'json_schema', schema: SOLVE_SCHEMA } },
    messages: [photoMessage(imageBase64, SOLVE_REQUEST)],
  }, apiKey);
  checkStop(data);
  return { result: JSON.parse(textOf(data.content)), usage: readUsage(data), model: data.model ?? model };
}

function collectLinks(content) {
  const links = new Map();
  const add = (url, title) => {
    if (/^https?:\/\//.test(url ?? '') && !links.has(url)) links.set(url, title || url);
  };
  for (const block of content) {
    for (const citation of block.citations ?? []) add(citation.url, citation.title);
  }
  if (links.size === 0) {
    for (const block of content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const hit of block.content) add(hit.url, hit.title);
      }
    }
  }
  return [...links].map(([url, title]) => ({ url, title }));
}

async function webSearch(result, { apiKey, model }) {
  const tool = model === 'claude-haiku-5-5' ? 'web_search_20250305' : 'web_search_20260209';
  const messages = [{ role: 'user', content: webRequest(result) }];
  const usage = { input: 0, output: 0, searches: 0 };
  const content = [];

  // 서버 쪽 검색이 길어지면 pause_turn으로 멈추므로 이어서 요청한다.
  for (let turn = 0; turn < 3; turn++) {
    const data = await callClaude({
      model,
      max_tokens: 16000,
      system: WEB_SYSTEM,
      output_config: { effort: 'low' },
      tools: [{ type: tool, name: 'web_search', max_uses: 1 }],
      messages,
    }, apiKey);
    checkStop(data);
    const used = readUsage(data);
    usage.input += used.input;
    usage.output += used.output;
    usage.searches += used.searches;
    content.push(...data.content);
    if (data.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: data.content });
  }
  return { text: textOf(content), links: collectLinks(content), usage };
}

// 출처를 찾아주는 방법 목록. 다른 AI나 검색 수단을 붙일 때는 같은 모양의 항목을 추가한다.
// run은 { text, links, usage }를 돌려주면 되고, 카드와 기록 파일에는 자동으로 나타난다.
export const SOURCE_PROVIDERS = [
  { id: 'web', label: '웹 검색으로 확인', run: webSearch },
];
