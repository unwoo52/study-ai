// 카드와 사진은 IndexedDB에 둔다. 브라우저가 탭을 정리해도 이어서 분석할 수 있다.
const DB_NAME = 'study-ai';
const OLD_LOG_KEY = 'text';

let dbPromise;
let logCounter = 0;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('items', { keyPath: 'id' });
      request.result.createObjectStore('log');
    };
    request.onsuccess = () => {
      const db = request.result;
      // 폰이 백그라운드에서 연결을 끊을 수 있으므로 다음 요청 때 새로 연다.
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

async function transact(storeName, mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    // 저장 공간이 부족하면 error 없이 abort만 올 수 있다.
    tx.onabort = () => reject(tx.error ?? new Error('저장이 취소됐어요.'));
  });
}

async function run(storeName, mode, action) {
  try {
    return await transact(storeName, mode, action);
  } catch (error) {
    if (error?.name !== 'InvalidStateError') throw error;
    dbPromise = null;
    return transact(storeName, mode, action);
  }
}

export const loadItems = () => run('items', 'readonly', (s) => s.getAll());
export const saveItem = (item) => run('items', 'readwrite', (s) => s.put(item));
export const clearItems = () => run('items', 'readwrite', (s) => s.clear());

// 기록은 항목마다 따로 저장한다. 하나의 글로 이어 붙이면 동시에 쓸 때 일부가 사라진다.
export async function readLog() {
  const old = await run('log', 'readonly', (s) => s.get(OLD_LOG_KEY));
  const entries = await run('log', 'readonly', (s) => s.getAll(IDBKeyRange.bound(0, Infinity)));
  return (old ?? '') + entries.join('');
}

export const appendLog = (entry) => run('log', 'readwrite', (s) => s.put(entry, Date.now() + (logCounter++ % 1000) / 1000));
