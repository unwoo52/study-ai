import { MODELS, SOURCE_PROVIDERS, costOf, solve } from './api.js';
import { DIFFICULTY_LABELS, TRAP_LABELS } from './prompt.js';
import { appendLog, clearItems, loadItems, readLog, saveItem } from './store.js';

const IMAGE_MAX_EDGE = 2000;
const IMAGE_QUALITY = 0.85;
const MAX_PARALLEL = 3;

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
let running = 0;

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

function itemCost(item) {
  let total = item.solve ? costOf(item.solve.usage, item.solve.model) : 0;
  for (const source of Object.values(item.sources)) {
    if (source.usage) total += costOf(source.usage, item.solve?.model);
  }
  return total;
}

const questionNumber = (item) => item.solve?.result.question_number ?? null;
const itemLabel = (item) => questionNumber(item) ?? (item.solve ? '?' : '…');

// 화면의 문제 번호 순서. 번호를 모르는 사진은 뒤로 보내고 찍은 순서를 유지한다.
function byQuestionNumber(a, b) {
  return (questionNumber(a) ?? Infinity) - (questionNumber(b) ?? Infinity) || a.n - b.n;
}

function spending() {
  const solved = items.filter((item) => item.solve);
  const total = solved.reduce((sum, item) => sum + itemCost(item), 0);
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
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', IMAGE_QUALITY));
}

async function addFiles(files) {
  for (const file of files) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    await addPhoto(await shrink(bitmap, bitmap.width, bitmap.height));
    bitmap.close();
  }
}

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.split(',')[1]);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

function photoUrl(item) {
  if (!photoUrls.has(item.id)) photoUrls.set(item.id, URL.createObjectURL(item.photo));
  return photoUrls.get(item.id);
}

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
  await saveItem(item);
  enqueue(item);
}

/* 분석 대기열 */

function enqueue(item) {
  item.status = 'queued';
  item.error = null;
  refresh(item);
  queue.push(item);
  pump();
}

function pump() {
  if (!settings.apiKey) {
    if (queue.length > 0 && !$('settings').open) openSettings();
    return;
  }
  while (running < MAX_PARALLEL && queue.length > 0) {
    running++;
    analyze(queue.shift()).finally(() => {
      running--;
      pump();
    });
  }
}

async function analyze(item) {
  item.status = 'running';
  refresh(item);
  const startedAt = performance.now();
  try {
    const solved = await solve(await toBase64(item.photo), settings);
    item.solve = solved;
    item.solveMs = performance.now() - startedAt;
    item.sources = {};
    item.status = 'done';
    item.logged = false;
  } catch (error) {
    item.status = 'error';
    item.error = error.message;
  }
  await saveItem(item);
  placeInOrder(item);
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
  await saveItem(item);
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
  item.logged = true;
  await saveItem(item);
  await appendLog(logEntry(item));
}

async function downloadLog() {
  const text = await readLog();
  const link = h('a', {
    href: URL.createObjectURL(new Blob(['﻿', text], { type: 'text/plain;charset=utf-8' })),
    download: 'study-log.txt',
  });
  link.click();
  URL.revokeObjectURL(link.href);
}

/* 카드 그리기 */

function renderStatus(item) {
  if (item.status === 'error') {
    return h('div', { class: 'status error' },
      h('img', { src: photoUrl(item), alt: '촬영한 문제 사진' }),
      h('p', {}, item.error),
      h('button', { class: 'btn', onclick: () => enqueue(item) }, '다시 시도'));
  }
  return h('div', { class: 'status' },
    h('img', { src: photoUrl(item), alt: '촬영한 문제 사진' }),
    h('p', {}, item.status === 'queued' ? '순서를 기다리는 중...' : '분석 중...'));
}

const TRAP_VERDICTS = {
  clean: '함정 없음',
  suspicious: '함정 의심',
  detected: '함정 발견',
};
const CONFIDENCE = { high: '높음', medium: '보통', low: '낮음' };

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
  return h('div', { class: 'card' },
    h('div', { class: 'head' },
      h('button', { class: 'thumb', 'aria-label': '사진 크게 보기', onclick: () => zoomPhoto(item) },
        h('img', { src: photoUrl(item), alt: '' })),
      h('div', { class: 'answer' },
        h('small', {}, `정답 · 신뢰도 ${CONFIDENCE[result.confidence]}`),
        h('strong', {}, `${result.answer_label}${correct ? `) ${correct.text_ko}` : ''}`))),
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

function placeInOrder(item) {
  const index = currentIndex();
  const viewing = items[index];
  items.sort(byQuestionNumber);
  const next = items[items.indexOf(item) + 1];
  deck.insertBefore(slides.get(item.id), next ? slides.get(next.id) : camSlide);
  $('chips').insertBefore(chips.get(item.id), next ? chips.get(next.id) : null);
  // 보던 카드의 위치가 밀렸을 때만 옮긴다. 넘기는 도중의 손동작을 끊지 않기 위해서다.
  const target = viewing ? items.indexOf(viewing) : items.length;
  if (target !== index) goTo(target);
}

function refresh(item) {
  const slide = slides.get(item.id);
  const top = slide.scrollTop;
  slide.replaceChildren(item.status === 'done' ? renderResult(item) : renderStatus(item));
  slide.scrollTop = top;

  const chip = chips.get(item.id);
  const verdict = item.status === 'done' ? item.solve.result.trap_check.verdict : '';
  chip.className = `chip ${item.status} ${verdict}`;
  chip.replaceChildren(String(itemLabel(item)));
  if (item.status === 'done') chip.append(h('b', {}, item.solve.result.answer_label));
  if (item.status === 'error') chip.append('!');
  updateHeader();
}

/* 화면 이동 */

function currentIndex() {
  return Math.round(deck.scrollLeft / deck.clientWidth);
}

function goTo(index) {
  deck.scrollTo({ left: index * deck.clientWidth, behavior: 'auto' });
  updateHeader();
}

function updateHeader() {
  const index = currentIndex();
  $('pos').textContent = index >= items.length ? `촬영 (${items.length}장)` : `${itemLabel(items[index])}번 문제`;
  const { sample, total, projected } = spending();
  const estimate = sample.length > 0 ? ` · ${settings.target}문제 예상 $${projected.toFixed(2)}` : '';
  $('spent').textContent = total > 0 ? `${usd(total)}${estimate}` : '';
  $('spent').classList.toggle('over', projected > settings.budget);
  items.forEach((item, i) => chips.get(item.id).classList.toggle('active', i === index));
  chips.get(items[index]?.id)?.scrollIntoView({ block: 'nearest' });
}

function zoomPhoto(item) {
  $('zoom').querySelector('img').src = photoUrl(item);
  $('zoom').showModal();
}

/* 카메라 */

let stream = null;

function showCameraFallback(reason) {
  $('camFallback').hidden = false;
  $('camReason').textContent = reason;
  $('shutter').disabled = true;
}

async function startCamera() {
  if (stream || document.hidden) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraFallback('이 주소에서는 앱 안 카메라를 쓸 수 없어요. 아래 "기본 카메라" 버튼으로 찍어 주세요.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
    video.srcObject = stream;
    $('camFallback').hidden = true;
    $('shutter').disabled = false;
  } catch {
    showCameraFallback('카메라를 켤 수 없어요. 권한을 허용하거나 아래 "기본 카메라" 버튼으로 찍어 주세요.');
  }
}

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
}

async function shoot() {
  if (!video.videoWidth) return;
  const flash = $('flash');
  flash.classList.remove('on');
  void flash.offsetWidth;
  flash.classList.add('on');
  navigator.vibrate?.(30);
  await addPhoto(await shrink(video, video.videoWidth, video.videoHeight));
}

/* 설정 */

function openSettings() {
  $('apiKey').value = settings.apiKey;
  $('model').value = settings.model;
  $('effort').value = settings.effort;
  $('autoSources').checked = settings.autoSources;
  $('budget').value = settings.budget;
  $('target').value = settings.target;
  const { sample, total, average, projected } = spending();
  if (sample.length > 0) {
    const avgMs = sample.reduce((sum, item) => sum + item.solveMs, 0) / sample.length;
    const verdict = projected > settings.budget ? '예산 초과' : '예산 안';
    $('stats').textContent = `지금까지 총 ${usd(total)}\n`
      + `${settings.model} ${sample.length}문제 기준 평균 ${usd(average)}, ${(avgMs / 1000).toFixed(1)}초\n`
      + `${settings.target}문제 예상 $${projected.toFixed(2)} (${verdict}, 예산 $${settings.budget})`;
  } else {
    $('stats').textContent = '';
  }
  $('settings').showModal();
}

function saveSettings() {
  settings.apiKey = $('apiKey').value.trim();
  settings.model = $('model').value;
  settings.effort = $('effort').value;
  settings.autoSources = $('autoSources').checked;
  settings.budget = Number($('budget').value) || defaults.budget;
  settings.target = Number($('target').value) || defaults.target;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 저장이 막힌 브라우저에서는 이번 접속 동안만 유지된다.
  }
  items.forEach(refresh);
  pump();
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
  slides.forEach((slide) => slide.remove());
  chips.forEach((chip) => chip.remove());
  slides.clear();
  chips.clear();
  photoUrls.forEach((url) => URL.revokeObjectURL(url));
  photoUrls.clear();
  updateHeader();
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
  deck.addEventListener('scroll', updateHeader, { passive: true });
  document.addEventListener('visibilitychange', () => (document.hidden ? stopCamera() : startCamera()));
}

async function restore() {
  const saved = await loadItems();
  saved.sort(byQuestionNumber);
  for (const item of saved) {
    for (const [id, source] of Object.entries(item.sources)) {
      if (source.status === 'running') delete item.sources[id];
    }
    items.push(item);
    addSlide(item);
    if (item.status === 'queued' || item.status === 'running') enqueue(item);
    if (item.status === 'done') logItem(item);
  }
}

$('model').append(...Object.entries(MODELS).map(([id, { label }]) => h('option', { value: id }, label)));
wireEvents();
await restore();
goTo(items.length);
updateHeader();
startCamera();
if (!settings.apiKey) openSettings();
