// 카드와 사진은 IndexedDB에 둔다. 브라우저가 탭을 정리해도 이어서 분석할 수 있다.
const DB_NAME = 'study-ai';
const LOG_KEY = 'text';

let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('items', { keyPath: 'id' });
      request.result.createObjectStore('log');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function run(storeName, mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const loadItems = () => run('items', 'readonly', (s) => s.getAll());
export const saveItem = (item) => run('items', 'readwrite', (s) => s.put(item));
export const clearItems = () => run('items', 'readwrite', (s) => s.clear());

export const readLog = async () => (await run('log', 'readonly', (s) => s.get(LOG_KEY))) ?? '';

export async function appendLog(entry) {
  const current = await readLog();
  await run('log', 'readwrite', (s) => s.put(current + entry, LOG_KEY));
}
