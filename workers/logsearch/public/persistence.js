(function (root) {
  "use strict";

  const DB_NAME = "logsearch-session";
  const DB_VERSION = 1;
  const FILE_STORE = "files";
  const STATE_STORE = "state";
  const ACTIVE_STATE_KEY = "active";

  let databasePromise = null;

  function isSupported() {
    return !!(root && root.indexedDB);
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error("IndexedDB request failed."));
    });
  }

  function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error || new Error("IndexedDB transaction aborted."));
      transaction.onerror = () =>
        reject(transaction.error || new Error("IndexedDB transaction failed."));
    });
  }

  function openDatabase() {
    if (!isSupported()) {
      return Promise.reject(
        new Error("This browser does not support local session storage.")
      );
    }
    if (databasePromise) return databasePromise;

    databasePromise = new Promise((resolve, reject) => {
      const request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(FILE_STORE)) {
          database.createObjectStore(FILE_STORE, { keyPath: "order" });
        }
        if (!database.objectStoreNames.contains(STATE_STORE)) {
          database.createObjectStore(STATE_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = null;
        };
        resolve(database);
      };
      request.onerror = () => {
        databasePromise = null;
        reject(request.error || new Error("Could not open local session storage."));
      };
    });
    return databasePromise;
  }

  async function requestPersistentStorage() {
    const storage = root.navigator && root.navigator.storage;
    if (!storage || typeof storage.persist !== "function") return false;
    try {
      return await storage.persist();
    } catch (error) {
      return false;
    }
  }

  function fileRecord(item, order) {
    const file = item && item.file;
    const path = String((item && item.path) || (file && file.name) || "");
    return {
      order,
      path,
      blob: file,
      name: String((file && file.name) || path.split("/").pop() || "file"),
      type: String((file && file.type) || ""),
      lastModified: Number((file && file.lastModified) || 0),
      size: Number((file && file.size) || 0),
    };
  }

  async function replaceSession(items, state) {
    const database = await openDatabase();
    const transaction = database.transaction(
      [FILE_STORE, STATE_STORE],
      "readwrite"
    );
    const complete = transactionComplete(transaction);
    const files = transaction.objectStore(FILE_STORE);
    const states = transaction.objectStore(STATE_STORE);

    files.clear();
    const list = Array.isArray(items) ? items : [];
    for (let index = 0; index < list.length; index++) {
      files.put(fileRecord(list[index], index));
    }
    if (list.length) {
      states.put({
        ...(state || {}),
        key: ACTIVE_STATE_KEY,
        updatedAt: Date.now(),
      });
    } else {
      states.delete(ACTIVE_STATE_KEY);
    }

    await complete;
    void requestPersistentStorage();
    return list.length;
  }

  async function saveState(state) {
    const database = await openDatabase();
    const transaction = database.transaction(STATE_STORE, "readwrite");
    const complete = transactionComplete(transaction);
    transaction.objectStore(STATE_STORE).put({
      ...(state || {}),
      key: ACTIVE_STATE_KEY,
      updatedAt: Date.now(),
    });
    await complete;
  }

  function selectionFromRecord(record) {
    if (!record || !record.blob || typeof root.File !== "function") return null;
    const file = new root.File([record.blob], record.name || "file", {
      type: record.type || "",
      lastModified: Number(record.lastModified) || 0,
    });
    return { file, path: String(record.path || file.name) };
  }

  async function loadSession() {
    if (!isSupported()) return null;
    const database = await openDatabase();
    const transaction = database.transaction(
      [FILE_STORE, STATE_STORE],
      "readonly"
    );
    const complete = transactionComplete(transaction);
    const stateRequest = transaction
      .objectStore(STATE_STORE)
      .get(ACTIVE_STATE_KEY);
    const filesRequest = transaction.objectStore(FILE_STORE).getAll();
    const [state, records] = await Promise.all([
      requestValue(stateRequest),
      requestValue(filesRequest),
      complete,
    ]);
    if (!state || !Array.isArray(records) || !records.length) return null;

    const files = records
      .slice()
      .sort((a, b) => Number(a.order) - Number(b.order))
      .map(selectionFromRecord)
      .filter(Boolean);
    if (!files.length) return null;

    const snapshot = { ...state };
    delete snapshot.key;
    return { files, state: snapshot };
  }

  async function clearSession() {
    if (!isSupported()) return;
    const database = await openDatabase();
    const transaction = database.transaction(
      [FILE_STORE, STATE_STORE],
      "readwrite"
    );
    const complete = transactionComplete(transaction);
    transaction.objectStore(FILE_STORE).clear();
    transaction.objectStore(STATE_STORE).delete(ACTIVE_STATE_KEY);
    await complete;
  }

  root.LogSearchPersistence = {
    clearSession,
    isSupported,
    loadSession,
    replaceSession,
    saveState,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
