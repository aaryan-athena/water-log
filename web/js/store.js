// Detection history, kept in this browser (IndexedDB).
//
// The API is stateless so it can run serverless; there is no shared server
// database. History therefore lives per device and survives reloads.

const DB_NAME = "waterlogging-watch";
const STORE = "checks";
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("created_at", "created_at");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
  }));
}

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const notify = () => listeners.forEach((fn) => fn());

export async function add(record) {
  const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`);
  await run("readwrite", (s) => s.put({ id, created_at: Date.now(), ...record }));
  notify();
  return id;
}

export async function all() {
  const rows = await run("readonly", (s) => s.getAll());
  return (rows || []).sort((a, b) => b.created_at - a.created_at);
}

export async function remove(id) {
  await run("readwrite", (s) => s.delete(id));
  notify();
}

export async function clear() {
  await run("readwrite", (s) => s.clear());
  notify();
}
