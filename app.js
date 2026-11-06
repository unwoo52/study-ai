import { MODELS, QUICK_LEVELS, QUICK_MODEL, SOURCE_PROVIDERS, costOf, quickSolve, solve } from './api.js';
import { DIFFICULTY_LABELS, TRAP_LABELS } from './prompt.js';
import { appendLog, clearItems, loadItems, readLog, saveItem } from './store.js';

const IMAGE_MAX_EDGE = 2000;
const IMAGE_QUALITY = 0.85;
const MAX_PARALLEL = 3;
const QUICK_PARALLEL = 2;
const MAX_ITEM_FAILS = 5;
const MODEL_FALLBACK_AFTER = 2;
const QUICK_MAX_FAILS = 2;
const RATE_COOLDOWN_MS = 15000;
const FAIL_COOLDOWN_MS = 3000;
const SPEEDUP_AFTER = 5;
const RENDER_RADIUS = 2;
const PROGRESS_MIN = 3;
const UPDATE_DELAY_MS = 120;

const $ = (id) => document.getElementById(id);
const deck = $('deck');
const camSlide = $('cam');
const video = $('video');

const SETTINGS_KEY = 'study-ai.settings.v2';
const OLD_SETTINGS_KEY = 'study-ai.settings';
const defaults = {
  apiKey: '',
  model: 'claude-haiku-5-5',
  effort: 'medium',
  autoSources: false,
  quickEnabled: true,
  quickLevel: 'brief',
  budget: 10,
  target: 300,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (saved) return { ...defaults, ...saved };
    // 예전 설정에서는 API 키만 가져온다. 모델과 웹 검색은 예산에 맞춘 새 기본값을 쓴다.
    const old = JSON.parse(localStorage.getItem(OLD_SETTINGS_KEY));
    return { ...defaults, apiKey: old?.apiKey ?? '' };
  } catch {
    return { ...defaults };
  }
}

const settings = loadSettings();
const items = [];
const queue = [];
const slides = new Map();
const chips = new Map();
const photoUrls = new Map();
const quickRunning = new Set();
const quickWaiting = [];
const rendered = new Set();
let running = 0;
let parallel = MAX_PARALLEL;
let okStreak = 0;
let cooldownUntil = 0;
let cooldownTimer = null;
let pausedReason = null;
let storageProblem = null;
let updateTimer = null;
let activeChip = null;
let wakeLock = null;
let wakeRequesting = false;

function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (value != null && value !== false) element.setAttribute(key, value);
  }
  element.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
  return element;
}

const usd = (value) => `$${value.toFixed(4)}`;
const seconds = (ms) => (ms / 1000).toFixed(1);

function itemCost(item) {
  let total = item.solve ? costOf(item.solve.usage, item.solve.model) : 0;
  if (item.quick) total += costOf(item.quick.usage, item.quick.model);
  for (const source of Object.values(item.sources)) {
    if (source.usage) total += costOf(source.usage, item.solve?.model);
  }
  return total;
}

const questionNumber = (item) => item.solve?.result?.question_number ?? item.quick?.result?.question_number ?? null;
const itemLabel = (item) => questionNumber(item) ?? (item.solve ? '?' : '…');

// 화면의 문제 번호 순서. 번호를 모르는 사진은 뒤로 보내고 찍은 순서를 유지한다.
function byQuestionNumber(a, b) {
  return (questionNumber(a) ?? Infinity) - (questionNumber(b) ?? Infinity) || a.n - b.n;
}

function spending() {
  const solved = items.filter((item) => item.solve);
  const total = items.reduce((sum, item) => sum + itemCost(item), 0);
  // 모델이 섞이면 평균이 왜곡되므로 예상치는 지금 고른 모델의 결과로만 낸다.
  const sample = solved.filter((item) => item.solve.model === settings.model);
  const average = sample.length > 0 ? sample.reduce((sum, item) => sum + itemCost(item), 0) / sample.length : 0;
  return { sample, total, average, projected: average * settings.target };
}

/* 사진 처리 */

async function shrink(source, width, height) {
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', IMAGE_QUALITY));
  canvas.width = 0;
  if (!blob) throw new Error('사진을 처리하지 못했어요. 다시 찍어 주세요.');
  return blob;
}

async function addFiles(files) {
  let failed = 0;
  for (const file of files) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      await addPhoto(await shrink(bitmap, bitmap.width, bitmap.height));
    } catch {
      failed++;
    } finally {
      bitmap?.close();
    }
  }
  if (failed > 0) showError(`${failed}장은 불러오지 못했어요.`);
}

const toBase64 = (blob) => new Promise((resolve, reject) => {
  if (!blob) {
    reject(new Error('사진이 없어서 풀 수 없어요. 다시 찍어 주세요.'));
    return;
  }
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.split(',')[1]);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

function photoUrl(item) {
  if (!item.photo) return '';
  if (!photoUrls.has(item.id)) photoUrls.set(item.id, URL.createObjectURL(item.photo));
  return photoUrls.get(item.id);
}

const photoImage = (item, alt) => h('img', { src: photoUrl(item), alt, loading: 'lazy', decoding: 'async' });

async function addPhoto(photo) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    n: Math.max(0, ...items.map((other) => other.n)) + 1,
    createdAt: Date.now(),
    photo,
    status: 'queued',
    sources: {},
  };
  const stayOnCamera = currentIndex() === items.length;
  items.push(item);
  addSlide(item);
  if (stayOnCamera) deck.scrollLeft = deck.scrollWidth;
  await persist(item);
  enqueue(item);
}

// 저장에 실패해도 풀이는 계속한다. 카드는 앱을 닫기 전까지 화면에 남는다.
async function persist(item) {
  try {
    await saveItem(item);
    storageProblem = null;
  } catch (error) {
    storageProblem = error?.name === 'QuotaExceededError' ? '저장 공간이 부족해요.' : '기기에 저장하지 못했어요.';
  }
  scheduleUpdate();
}

/* 분석 대기열 */

function enqueue(item) {
  if (item.status === 'running' || queue.includes(item)) return;
  item.status = 'queued';
  item.error = null;
  refresh(item);
  queue.push(item);
  if (needsQuick(item)) quickWaiting.push(item);
  pump();
}

function requeue(item, atFront) {
  item.status = 'queued';
  if (atFront) queue.unshift(item);
  else queue.push(item);
}

const remaining = () => queue.length + running;
const canSendSoon = () => pausedReason === null && navigator.onLine;
const canSend = () => canSendSoon() && Date.now() >= cooldownUntil;

function pump() {
  if (!settings.apiKey) {
    if (queue.length > 0 && !$('settings').open) openSettings();
    return;
  }
  if (canSend()) {
    // 빠른 답은 방금 찍은 사진부터 처리한다. 밀린 사진은 풀이가 먼저 끝나면 건너뛴다.
    // 요청 한도에 걸린 직후에는 풀이가 먼저 진행되도록 빠른 답을 줄인다.
    const quickLimit = parallel < MAX_PARALLEL ? 1 : QUICK_PARALLEL;
    while (quickRunning.size < quickLimit && quickWaiting.length > 0) quickAnswer(quickWaiting.pop());
    while (running < parallel && queue.length > 0) {
      running++;
      analyze(queue.shift()).finally(() => {
        running--;
        pump();
      });
    }
  }
  keepAwake();
  scheduleUpdate();
}

function startCooldown(ms) {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
  clearTimeout(cooldownTimer);
  cooldownTimer = setTimeout(pump, cooldownUntil - Date.now() + 50);
}

function noteSuccess() {
  okStreak++;
  if (okStreak >= SPEEDUP_AFTER && parallel < MAX_PARALLEL) {
    parallel++;
    okStreak = 0;
  }
}

// 전체 대기열을 멈춰야 하는 실패면 true를 돌려준다. 이때 사진은 실패가 아니라 대기 상태로 남는다.
function noteFailure(error) {
  if (error.kind === 'fatal') {
    pausedReason = error.message;
    return true;
  }
  if (error.kind === 'rate') {
    parallel = Math.max(1, parallel - 1);
    okStreak = 0;
    startCooldown(error.delay ?? RATE_COOLDOWN_MS);
    return true;
  }
  return false;
}

function resume() {
  pausedReason = null;
  cooldownUntil = 0;
  pump();
}

function retryFailed() {
  for (const item of items.filter(({ status }) => status === 'error')) {
    item.fails = 0;
    enqueue(item);
  }
}

// 대량으로 푸는 동안 화면이 꺼지면 브라우저가 멈추므로 켜둔다.
async function keepAwake() {
  const wanted = remaining() > 0 && !document.hidden && canSendSoon();
  if (wanted && !wakeLock && !wakeRequesting && navigator.wakeLock) {
    wakeRequesting = true;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {
      // 배터리 절약 모드 등에서는 거절될 수 있다. 풀이에는 지장이 없다.
    }
    wakeRequesting = false;
  } else if (!wanted && wakeLock) {
    await wakeLock.release();
  }
}

function needsQuick(item) {
  return settings.quickEnabled
    && item.quick?.level !== settings.quickLevel
    && (item.status === 'queued' || item.status === 'running')
    && !quickRunning.has(item.id)
    && !quickWaiting.includes(item)
    && slides.has(item.id);
}

async function quickAnswer(item) {
  // 같은 단계로 이미 얻은 답은 다시 요청하지 않는다. 단계를 바꾸고 다시 풀면 새로 받아서 비교할 수 있다.
  if (!needsQuick(item)) return;
  quickRunning.add(item.id);
  item.quick = null;
  item.quickError = null;
  refresh(item);
  const startedAt = performance.now();
  let retry = false;
  try {
    const quick = await quickSolve(await toBase64(item.photo), settings.apiKey, settings.quickLevel);
    quick.ms = performance.now() - startedAt;
    item.quick = quick;
    noteSuccess();
  } catch (error) {
    item.quickFails = (item.quickFails ?? 0) + 1;
    retry = noteFailure(error) || (error.kind === 'transient' && item.quickFails < QUICK_MAX_FAILS);
    if (!retry) item.quickError = error.message;
  }
  quickRunning.delete(item.id);
  if (!slides.has(item.id)) return;
  if (retry) {
    if (needsQuick(item)) quickWaiting.unshift(item);
  } else if (item.quick) {
    await persist(item);
    placeInOrder();
  }
  refresh(item);
  pump();
}

async function analyze(item) {
  if (!slides.has(item.id)) return;
  item.status = 'running';
  refresh(item);
  const startedAt = performance.now();
  // 고른 모델이 계속 실패하면 가장 안정적으로 답하는 Haiku로 대신 푼다.
  const fallback = (item.fails ?? 0) >= MODEL_FALLBACK_AFTER && settings.model !== QUICK_MODEL;
  try {
    const solved = await solve(await toBase64(item.photo), { ...settings, model: fallback ? QUICK_MODEL : settings.model });
    item.solve = solved;
    item.solveMs = performance.now() - startedAt;
    item.sources = {};
    item.status = 'done';
    item.logged = false;
    item.fails = 0;
    noteSuccess();
  } catch (error) {
    if (!slides.has(item.id)) return;
    if (noteFailure(error)) {
      requeue(item, true);
    } else if (error.kind === 'transient') {
      if (navigator.onLine) item.fails = (item.fails ?? 0) + 1;
      if ((item.fails ?? 0) < MAX_ITEM_FAILS) {
        requeue(item, !navigator.onLine);
        if (item.fails > 0) startCooldown(FAIL_COOLDOWN_MS * item.fails);
      } else {
        item.status = 'error';
        item.error = error.message;
        item.retryOnline = true;
      }
    } else {
      item.status = 'error';
      item.error = error.message;
    }
  }
  if (!slides.has(item.id)) return;
  await persist(item);
  placeInOrder();
  refresh(item);
  if (item.status !== 'done') return;
  if (settings.autoSources) await Promise.all(SOURCE_PROVIDERS.map((provider) => findSource(item, provider)));
  await logItem(item);
}

async function findSource(item, provider) {
  item.sources[provider.id] = { status: 'running' };
  refresh(item);
  try {
    const found = await provider.run(item.solve.result, settings);
    item.sources[provider.id] = { status: 'done', ...found };
  } catch (error) {
    item.sources[provider.id] = { status: 'error', error: error.message };
  }
  if (!slides.has(item.id)) return;
  await persist(item);
  refresh(item);
}

/* 기록 파일 */

function logEntry(item) {
  const { result, model } = item.solve;
  const when = new Date(item.createdAt).toLocaleString('ko-KR');
  const lines = [
    `=== 문제 ${itemLabel(item)} (촬영 #${item.n}) | ${when} | ${model} | ${usd(itemCost(item))} | ${(item.solveMs / 1000).toFixed(1)}초 ===`,
    `[원문]\n${result.original_text}`,
    `[번역]\n${result.question_ko}`,
    ...result.choices.map((c) => `${c.label}) ${c.text_ko}${c.is_correct ? ' ← 정답' : ''}`),
    `[정답] ${result.answer_label} (신뢰도 ${result.confidence})`,
    item.quick && `[빠른 답] ${item.quick.result.answer_label} `
      + `(${QUICK_LEVELS[item.quick.level]?.label ?? '즉답'}, ${seconds(item.quick.ms)}초)`,
    `[해설]\n${result.explanation_ko}`,
    result.difficulty && `[난이도] ${DIFFICULTY_LABELS[result.difficulty.tier]} `
      + `(예상 정답률 ${result.difficulty.estimated_correct_rate}%): ${result.difficulty.reason}`,
    `[함정 점검] ${result.trap_check.verdict}: ${result.trap_check.summary}`,
    ...result.trap_check.findings.map((f) => `- ${TRAP_LABELS[f.type]} / ${f.location}: ${f.evidence}`),
    `[AI 지식 출처]`,
    ...result.own_sources.map((s) => `- ${s.title}: ${s.note}`),
  ];
  for (const provider of SOURCE_PROVIDERS) {
    const source = item.sources[provider.id];
    if (source?.status !== 'done') continue;
    lines.push(`[${provider.label}]\n${source.text}`, ...source.links.map((l) => `- ${l.title}: ${l.url}`));
  }
  return `${lines.filter(Boolean).join('\n')}\n\n`;
}

async function logItem(item) {
  if (item.logged) return;
  try {
    await appendLog(logEntry(item));
    item.logged = true;
    await persist(item);
  } catch {
    storageProblem = '기록 파일에 저장하지 못했어요.';
    scheduleUpdate();
  }
}

async function downloadLog() {
  let text;
  try {
    text = await readLog();
  } catch {
    showError('기록을 읽지 못했어요.');
    return;
  }
  const link = h('a', {
    href: URL.createObjectURL(new Blob(['﻿', text], { type: 'text/plain;charset=utf-8' })),
    download: 'study-log.txt',
  });
  link.click();
  // 내려받기가 시작될 시간을 준다.
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

/* 카드 그리기 */

function renderQuick(item) {
  if (item.quick) {
    return h('div', { class: 'quick' },
      h('small', {}, `빠른 답 · ${seconds(item.quick.ms)}초 · 풀이로 확인 전`),
      h('strong', {}, item.quick.result.answer_label),
      item.quick.result.reasoning && h('small', {}, item.quick.result.reasoning));
  }
  if (quickRunning.has(item.id)) return h('div', { class: 'quick' }, h('small', {}, '빠른 답 찾는 중...'));
  if (item.quickError) return h('div', { class: 'quick' }, h('small', {}, `빠른 답 실패: ${item.quickError}`));
  return null;
}

function renderStatus(item) {
  if (item.status === 'error') {
    return h('div', { class: 'status error' },
      renderQuick(item),
      photoImage(item, '촬영한 문제 사진'),
      h('p', {}, item.error),
      h('button', { class: 'btn', onclick: () => enqueue(item) }, '다시 시도'));
  }
  return h('div', { class: 'status' },
    renderQuick(item),
    h('p', {}, item.status === 'queued' ? '풀이 순서를 기다리는 중...' : '풀이 진행 중...'),
    photoImage(item, '촬영한 문제 사진'));
}

const TRAP_VERDICTS = {
  clean: '함정 없음',
  suspicious: '함정 의심',
  detected: '함정 발견',
};
const CONFIDENCE = { high: '높음', medium: '보통', low: '낮음' };

const bareLabel = (label) => label.replace(/[\s.)）]/g, '');
const quickAgrees = (item) => bareLabel(item.quick.result.answer_label) === bareLabel(item.solve.result.answer_label);

function renderTrap(trap) {
  return [
    h('h3', {}, '함정 점검'),
    h('div', { class: `notice ${trap.verdict}` }, h('b', {}, TRAP_VERDICTS[trap.verdict]), ` ${trap.summary}`),
    trap.findings.map((finding) => h('div', { class: 'finding' },
      h('b', {}, TRAP_LABELS[finding.type]),
      h('small', {}, `위치: ${finding.location}`),
      h('p', {}, finding.evidence),
      h('small', {}, finding.effect))),
  ];
}

function renderProvider(item, provider) {
  const source = item.sources[provider.id];
  if (!source || source.status === 'error') {
    return h('div', { class: 'source' },
      h('b', {}, provider.label),
      source && h('small', {}, source.error),
      h('button', { class: 'btn', onclick: () => findSource(item, provider).then(() => logItem(item)) },
        source ? '다시 찾기' : '찾아보기'));
  }
  if (source.status === 'running') {
    return h('div', { class: 'source' }, h('b', {}, provider.label), h('small', {}, '찾는 중...'));
  }
  return h('div', { class: 'source' },
    h('b', {}, provider.label),
    h('p', {}, source.text),
    source.links.length > 0 && h('ul', { class: 'links' }, source.links.map((link) =>
      h('li', {}, h('a', { href: link.url, target: '_blank', rel: 'noopener noreferrer' }, link.title)))));
}

function renderResult(item) {
  const { result, model } = item.solve;
  const correct = result.choices.find((choice) => choice.is_correct);
  const agrees = item.quick ? quickAgrees(item) : null;
  return h('div', { class: 'card' },
    h('div', { class: 'head' },
      h('button', { class: 'thumb', 'aria-label': '사진 크게 보기', onclick: () => zoomPhoto(item) },
        photoImage(item, '')),
      h('div', { class: 'answer' },
        h('small', {}, `정답 · 신뢰도 ${CONFIDENCE[result.confidence]}${agrees ? ' · 빠른 답과 같음' : ''}`),
        h('strong', {}, `${result.answer_label}${correct ? `) ${correct.text_ko}` : ''}`))),
    agrees === false && h('div', { class: 'notice detected' },
      `빠른 답(${item.quick.result.answer_label})과 달라요. 풀이 결과 ${result.answer_label}를 따르세요.`),
    result.image_quality !== 'good' && h('div', { class: 'notice' },
      `사진이 잘 안 읽혀요. ${result.image_note}`),
    result.trap_check.verdict !== 'clean' && h('div', { class: `notice ${result.trap_check.verdict}` },
      h('b', {}, TRAP_VERDICTS[result.trap_check.verdict]), ` ${result.trap_check.summary}`),
    result.difficulty && h('div', { class: `difficulty ${result.difficulty.tier}` },
      h('b', {}, DIFFICULTY_LABELS[result.difficulty.tier]),
      h('span', {}, `예상 정답률 ${result.difficulty.estimated_correct_rate}%`),
      h('small', {}, result.difficulty.reason)),
    h('h3', {}, '문제'),
    h('p', {}, result.question_ko),
    h('h3', {}, '선택지'),
    result.choices.map((choice) => h('div', { class: `choice ${choice.is_correct ? 'correct' : ''}` },
      h('span', { class: 'label' }, `${choice.label}) `), choice.text_ko,
      h('small', {}, choice.why))),
    h('h3', {}, '해설'),
    h('p', {}, result.explanation_ko),
    renderTrap(result.trap_check),
    h('h3', {}, '출처'),
    h('div', { class: 'source' },
      h('b', {}, 'AI 자체 지식 (링크 미확인)'),
      result.own_sources.length === 0 && h('small', {}, '제시할 만한 출처가 없어요.'),
      result.own_sources.map((source) => h('small', {}, `${source.title}: ${source.note}`))),
    SOURCE_PROVIDERS.map((provider) => renderProvider(item, provider)),
    h('details', {}, h('summary', {}, '일본어 원문'), h('p', { lang: 'ja' }, result.original_text)),
    h('div', { class: 'foot' },
      h('span', {}, `${model} · ${(item.solveMs / 1000).toFixed(0)}초 · ${usd(itemCost(item))}`),
      h('button', { class: 'btn', onclick: () => enqueue(item) }, '다시 풀기')));
}

function addSlide(item) {
  const slide = h('section', { class: 'slide' });
  const chip = h('button', { class: 'chip', onclick: () => goTo(items.indexOf(item)) });
  deck.insertBefore(slide, camSlide);
  $('chips').append(chip);
  slides.set(item.id, slide);
  chips.set(item.id, chip);
  refresh(item);
}

function renderCard(item) {
  try {
    return item.status === 'done' ? renderResult(item) : renderStatus(item);
  } catch {
    return h('div', { class: 'status error' },
      h('p', {}, '이 카드를 표시하지 못했어요.'),
      h('button', { class: 'btn', onclick: () => enqueue(item) }, '다시 풀기'));
  }
}

function renderSlide(item) {
  const slide = slides.get(item.id);
  const top = slide.scrollTop;
  rendered.add(item.id);
  slide.replaceChildren(renderCard(item));
  slide.scrollTop = top;
}

function placeInOrder() {
  const index = currentIndex();
  const viewing = items[index];
  items.sort(byQuestionNumber);
  // 여러 카드의 번호가 거의 동시에 정해질 수 있어서 전체 순서를 맞춘다. 제자리인 카드는 건드리지 않는다.
  let nextSlide = camSlide;
  let nextChip = null;
  for (const { id } of [...items].reverse()) {
    const slide = slides.get(id);
    const chip = chips.get(id);
    if (slide.nextElementSibling !== nextSlide) deck.insertBefore(slide, nextSlide);
    if (chip.nextElementSibling !== nextChip) $('chips').insertBefore(chip, nextChip);
    nextSlide = slide;
    nextChip = chip;
  }
  // 보던 카드의 위치가 밀렸을 때만 옮긴다. 넘기는 도중의 손동작을 끊지 않기 위해서다.
  const target = viewing ? items.indexOf(viewing) : items.length;
  if (target !== index) goTo(target);
}

function refresh(item) {
  const chip = chips.get(item.id);
  if (!chip) return;
  if (rendered.has(item.id)) renderSlide(item);
  const verdict = item.status === 'done' ? item.solve?.result?.trap_check?.verdict ?? '' : '';
  chip.className = `chip ${item.status} ${verdict}${chip === activeChip ? ' active' : ''}`;
  chip.replaceChildren(String(itemLabel(item)));
  const answer = item.status === 'done' ? item.solve?.result?.answer_label : item.quick?.result?.answer_label;
  if (answer) chip.append(h('b', {}, answer));
  if (item.status === 'error') chip.append('!');
  scheduleUpdate();
}

/* 화면 이동 */

function currentIndex() {
  // 화면이 가려져 폭이 0이면 위치를 계산할 수 없으므로 카메라 칸으로 본다.
  return deck.clientWidth ? Math.round(deck.scrollLeft / deck.clientWidth) : items.length;
}

function goTo(index) {
  deck.scrollTo({ left: index * deck.clientWidth, behavior: 'auto' });
  syncView();
}

// 보는 카드와 그 주변만 그린다. 400장을 모두 그려두면 폰 메모리가 부족해진다.
function syncView() {
  const index = currentIndex();
  $('pos').textContent = index >= items.length ? `촬영 (${items.length}장)` : `${itemLabel(items[index])}번 문제`;
  const chip = chips.get(items[index]?.id) ?? null;
  if (chip !== activeChip) {
    activeChip?.classList.remove('active');
    chip?.classList.add('active');
    activeChip = chip;
    chip?.scrollIntoView({ block: 'nearest' });
  }
  const nearby = items.slice(Math.max(0, index - RENDER_RADIUS), index + RENDER_RADIUS + 1);
  const keep = new Set(nearby.map((item) => item.id));
  for (const id of rendered) {
    if (keep.has(id)) continue;
    rendered.delete(id);
    slides.get(id)?.replaceChildren();
    if (photoUrls.has(id)) {
      URL.revokeObjectURL(photoUrls.get(id));
      photoUrls.delete(id);
    }
  }
  for (const item of nearby) {
    if (!rendered.has(item.id)) renderSlide(item);
  }
}

// 답이 들어올 때마다 전체를 다시 계산하지 않도록 잠깐 모아서 처리한다.
function scheduleUpdate() {
  updateTimer ??= setTimeout(() => {
    updateTimer = null;
    syncView();
    updateTotals();
    updateBanner();
  }, UPDATE_DELAY_MS);
}

function updateBanner() {
  const left = remaining();
  const failed = items.filter(({ status }) => status === 'error').length;
  const parts = [];
  if (storageProblem) parts.push(`${storageProblem} 기록을 내려받아 두세요.`);
  if (pausedReason) parts.push(`멈춤: ${pausedReason}`);
  else if (!navigator.onLine && left > 0) parts.push('인터넷 연결이 없어요. 연결되면 이어서 풀어요.');
  else if (Date.now() < cooldownUntil) parts.push('요청이 많아서 잠시 쉬었다가 이어서 풀어요.');
  if (left >= PROGRESS_MIN || (left > 0 && parts.length > 0)) parts.push(`남은 문제 ${left}장`);
  if (failed > 0) parts.push(`실패 ${failed}장`);
  $('bannerText').textContent = parts.join(' · ');
  $('banner').hidden = parts.length === 0;
  const action = $('bannerAction');
  action.hidden = !pausedReason && failed === 0;
  action.textContent = pausedReason ? '다시 시작' : '모두 다시 시도';
}

function updateTotals() {
  const { sample, total, projected } = spending();
  const estimate = sample.length > 0 ? ` · ${settings.target}문제 예상 $${projected.toFixed(2)}` : '';
  $('spent').textContent = total > 0 ? `${usd(total)}${estimate}` : '';
  $('spent').classList.toggle('over', projected > settings.budget);
}

function zoomPhoto(item) {
  $('zoom').querySelector('img').src = photoUrl(item);
  $('zoom').showModal();
}

/* 카메라 */

let stream = null;

function showCameraFallback(reason) {
  // 기본 카메라는 앱 밖으로 나가서 브라우저가 메모리 부족으로 닫힐 수 있으므로 앱 안 카메라가 안 될 때만 보여준다.
  $('camFallback').hidden = false;
  $('nativeLabel').hidden = false;
  $('camReason').textContent = reason;
  $('shutter').disabled = true;
}

async function startCamera() {
  if (stream || document.hidden) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraFallback('이 주소에서는 앱 안 카메라를 쓸 수 없어요. 아래 "기본 카메라"나 "갤러리"를 써 주세요.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } },
    });
    video.srcObject = stream;
    // 다른 앱이 카메라를 가져가면 끊긴다.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      stopCamera();
      startCamera();
    });
    $('camFallback').hidden = true;
    $('nativeLabel').hidden = true;
    $('shutter').disabled = false;
  } catch {
    showCameraFallback('카메라를 켤 수 없어요. 여기를 눌러 다시 시도하거나 아래 "기본 카메라"나 "갤러리"를 써 주세요.');
  }
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
}

async function shoot() {
  if (!video.videoWidth) {
    showError('카메라가 아직 준비되지 않았어요.');
    return;
  }
  const flash = $('flash');
  flash.classList.remove('on');
  void flash.offsetWidth;
  flash.classList.add('on');
  navigator.vibrate?.(30);
  try {
    await addPhoto(await shrink(video, video.videoWidth, video.videoHeight));
  } catch (error) {
    showError(error.message);
  }
}

/* 설정 */

function openSettings() {
  $('apiKey').value = settings.apiKey;
  $('model').value = settings.model;
  $('effort').value = settings.effort;
  $('autoSources').checked = settings.autoSources;
  $('quickEnabled').checked = settings.quickEnabled;
  $('quickLevel').value = settings.quickLevel;
  $('budget').value = settings.budget;
  $('target').value = settings.target;
  const { sample, total, average, projected } = spending();
  if (sample.length > 0) {
    const avgMs = sample.reduce((sum, item) => sum + item.solveMs, 0) / sample.length;
    const verdict = projected > settings.budget ? '예산 초과' : '예산 안';
    $('stats').textContent = `지금까지 총 ${usd(total)}\n`
      + `${settings.model} ${sample.length}문제 기준 평균 ${usd(average)}, ${(avgMs / 1000).toFixed(1)}초\n`
      + `${settings.target}문제 예상 $${projected.toFixed(2)} (${verdict}, 예산 $${settings.budget})`;
    $('stats').textContent += quickStats();
  } else {
    $('stats').textContent = '';
  }
  $('settings').showModal();
  showStorageUse();
}

async function showStorageUse() {
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  if (!estimate?.quota) return;
  const mb = (bytes) => Math.round(bytes / 1e6);
  const line = `저장 공간 ${mb(estimate.usage)}MB 사용, ${mb(estimate.quota - estimate.usage)}MB 남음`;
  $('stats').textContent += `${$('stats').textContent ? '\n' : ''}${line}`;
}

// 단계별로 풀이 결과와 얼마나 같았는지 보여준다. 풀이 결과도 공식 정답은 아니다.
function quickStats() {
  let text = '';
  for (const [id, { label }] of Object.entries(QUICK_LEVELS)) {
    const done = items.filter((item) => item.quick?.level === id && item.solve);
    if (done.length === 0) continue;
    const agreed = done.filter(quickAgrees).length;
    const average = (pick) => done.reduce((sum, item) => sum + pick(item), 0) / done.length;
    text += `\n빠른 답 ${label}: 풀이와 일치 ${agreed}/${done.length}, `
      + `평균 ${seconds(average((item) => item.quick.ms))}초, `
      + `${usd(average((item) => costOf(item.quick.usage, item.quick.model)))}`;
  }
  return text;
}

function saveSettings() {
  settings.apiKey = $('apiKey').value.trim();
  settings.model = $('model').value;
  settings.effort = $('effort').value;
  settings.autoSources = $('autoSources').checked;
  settings.quickEnabled = $('quickEnabled').checked;
  settings.quickLevel = $('quickLevel').value;
  settings.budget = Number($('budget').value) || defaults.budget;
  settings.target = Number($('target').value) || defaults.target;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 저장이 막힌 브라우저에서는 이번 접속 동안만 유지된다.
  }
  items.forEach(refresh);
  resume();
}

function rerunAll() {
  const targets = items.filter((item) => item.status === 'done' || item.status === 'error');
  if (targets.length === 0) return;
  if (!confirm(`${targets.length}문제를 현재 저장된 모델로 다시 풀까요? 비용이 다시 들어요.`)) return;
  $('settings').close();
  targets.forEach(enqueue);
}

async function clearAll() {
  if (!confirm('카드와 사진을 모두 지울까요? 기록 파일은 남아요.')) return;
  await clearItems();
  items.length = 0;
  queue.length = 0;
  quickWaiting.length = 0;
  rendered.clear();
  activeChip = null;
  slides.forEach((slide) => slide.remove());
  chips.forEach((chip) => chip.remove());
  slides.clear();
  chips.clear();
  photoUrls.forEach((url) => URL.revokeObjectURL(url));
  photoUrls.clear();
  goTo(0);
  scheduleUpdate();
  $('settings').close();
}

/* 시작 */

function showError(message) {
  const toast = $('toast');
  toast.textContent = `오류: ${message}`;
  toast.hidden = false;
  clearTimeout(showError.timer);
  showError.timer = setTimeout(() => { toast.hidden = true; }, 8000);
}

function wireEvents() {
  window.addEventListener('error', (event) => showError(event.message));
  window.addEventListener('unhandledrejection', (event) => showError(event.reason?.message ?? event.reason));
  $('shutter').addEventListener('click', shoot);
  for (const input of [$('gallery'), $('native')]) {
    input.addEventListener('change', async () => {
      const files = [...input.files];
      input.value = '';
      await addFiles(files);
    });
  }
  $('goCam').addEventListener('click', () => goTo(items.length));
  $('openSettings').addEventListener('click', openSettings);
  $('settings').querySelector('form').addEventListener('submit', saveSettings);
  $('downloadLog').addEventListener('click', downloadLog);
  $('rerunAll').addEventListener('click', rerunAll);
  $('clearAll').addEventListener('click', clearAll);
  $('zoom').addEventListener('click', () => $('zoom').close());
  deck.addEventListener('scroll', syncView, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopCamera();
    } else {
      startCamera();
      pump();
    }
  });
  window.addEventListener('offline', scheduleUpdate);
  window.addEventListener('online', () => {
    for (const item of items.filter((other) => other.status === 'error' && other.retryOnline)) {
      item.fails = 0;
      item.retryOnline = false;
      enqueue(item);
    }
    pump();
  });
  $('camFallback').addEventListener('click', startCamera);
  $('bannerAction').addEventListener('click', () => (pausedReason ? resume() : retryFailed()));
}

// 앱이 도중에 꺼졌거나 저장본이 손상돼도 나머지 카드는 살린다.
function repair(item) {
  item.sources ??= {};
  for (const [id, source] of Object.entries(item.sources)) {
    if (source.status === 'running') delete item.sources[id];
  }
  if (item.status === 'running') item.status = 'queued';
  if (!(item.photo instanceof Blob)) item.photo = null;
  if (item.quick && !(item.quick.result && item.quick.usage)) item.quick = null;
  const result = item.solve?.result;
  if (item.solve && !(result?.choices && result.trap_check && item.solve.usage)) {
    delete item.solve;
    item.status = 'error';
    item.error = '저장된 결과가 손상됐어요. 다시 풀어 주세요.';
  }
}

async function restore() {
  let saved;
  try {
    saved = await loadItems();
  } catch {
    storageProblem = '저장된 카드를 불러오지 못했어요.';
    return;
  }
  saved = saved.filter((item) => {
    try {
      repair(item);
      return true;
    } catch {
      return false;
    }
  });
  saved.sort(byQuestionNumber);
  for (const item of saved) {
    items.push(item);
    addSlide(item);
    if (item.status === 'queued' || item.status === 'running') enqueue(item);
    if (item.status === 'done') logItem(item);
  }
}

$('model').append(...Object.entries(MODELS).map(([id, { label }]) => h('option', { value: id }, label)));
$('quickLevel').append(...Object.entries(QUICK_LEVELS).map(([id, { label, detail }]) =>
  h('option', { value: id }, `${label} ${detail}`)));
wireEvents();
await restore();
goTo(items.length);
scheduleUpdate();
startCamera();
window.appStarted = true;
navigator.storage?.persist?.();
navigator.serviceWorker?.register('sw.js').catch(() => {});
if (!settings.apiKey) openSettings();
