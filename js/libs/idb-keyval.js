// idb-keyval v6.2.1 (Manual implementation)
// 來源參考: https://github.com/jakearchibald/idb-keyval
// 用途：提供極輕量的 Promise-based IndexedDB 封裝

var idbKeyval = (function (exports) {
  "use strict";

  function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      // @ts-ignore - file size hacks
      request.oncomplete = request.onsuccess = () => resolve(request.result);
      // @ts-ignore - file size hacks
      request.onabort = request.onerror = () => reject(request.error);
    });
  }

  function createStore(dbName, storeName) {
    const request = indexedDB.open(dbName);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    const dbp = promisifyRequest(request);
    return (txMode, callback) =>
      dbp.then((db) =>
        callback(db.transaction(storeName, txMode).objectStore(storeName))
      );
  }

  let defaultGetStoreFunc;
  function defaultGetStore() {
    if (!defaultGetStoreFunc) {
      defaultGetStoreFunc = createStore("keyval-store", "keyval");
    }
    return defaultGetStoreFunc;
  }

  function get(key, customStore = defaultGetStore()) {
    return customStore("readonly", (store) => promisifyRequest(store.get(key)));
  }

  function set(key, value, customStore = defaultGetStore()) {
    return customStore("readwrite", (store) => {
      store.put(value, key);
      return promisifyRequest(store.transaction);
    });
  }

  function setMany(entries, customStore = defaultGetStore()) {
    return customStore("readwrite", (store) => {
      entries.forEach((entry) => store.put(entry[1], entry[0]));
      return promisifyRequest(store.transaction);
    });
  }

  function getMany(keys, customStore = defaultGetStore()) {
    return customStore("readonly", (store) =>
      Promise.all(keys.map((key) => promisifyRequest(store.get(key))))
    );
  }

  function update(key, updater, customStore = defaultGetStore()) {
    return customStore(
      "readwrite",
      (store) =>
        // Need to create the promise manually.
        // If I try to chain promises, the transaction closes in browsers
        // that use a promise polyfill (IE10/11).
        new Promise((resolve, reject) => {
          store.get(key).onsuccess = function () {
            try {
              store.put(updater(this.result), key);
              resolve(promisifyRequest(store.transaction));
            } catch (err) {
              reject(err);
            }
          };
        })
    );
  }

  function del(key, customStore = defaultGetStore()) {
    return customStore("readwrite", (store) => {
      store.delete(key);
      return promisifyRequest(store.transaction);
    });
  }

  function delMany(keys, customStore = defaultGetStore()) {
    return customStore("readwrite", (store) => {
      keys.forEach((key) => store.delete(key));
      return promisifyRequest(store.transaction);
    });
  }

  function clear(customStore = defaultGetStore()) {
    return customStore("readwrite", (store) => {
      store.clear();
      return promisifyRequest(store.transaction);
    });
  }

  function keys(customStore = defaultGetStore()) {
    return customStore("readonly", (store) => {
      // Faster than cursor
      if (store.getAllKeys) {
        return promisifyRequest(store.getAllKeys());
      }
      // Fallback
      const items = [];
      return customStore("readonly", (store) => {
        store.openCursor().onsuccess = function () {
          if (!this.result) return;
          items.push(this.result.key);
          this.result.continue();
        };
        return promisifyRequest(store.transaction).then(() => items);
      });
    });
  }

  function values(customStore = defaultGetStore()) {
    return customStore("readonly", (store) => {
      if (store.getAll) {
        return promisifyRequest(store.getAll());
      }
      const items = [];
      return customStore("readonly", (store) => {
        store.openCursor().onsuccess = function () {
          if (!this.result) return;
          items.push(this.result.value);
          this.result.continue();
        };
        return promisifyRequest(store.transaction).then(() => items);
      });
    });
  }

  function entries(customStore = defaultGetStore()) {
    return customStore("readonly", (store) => {
      // Faster than cursor
      if (store.getAll && store.getAllKeys) {
        return Promise.all([
          promisifyRequest(store.getAllKeys()),
          promisifyRequest(store.getAll()),
        ]).then(([keys, values]) => keys.map((key, i) => [key, values[i]]));
      }
      const items = [];
      return customStore("readonly", (store) => {
        store.openCursor().onsuccess = function () {
          if (!this.result) return;
          items.push([this.result.key, this.result.value]);
          this.result.continue();
        };
        return promisifyRequest(store.transaction).then(() => items);
      });
    });
  }

  exports.clear = clear;
  exports.createStore = createStore;
  exports.del = del;
  exports.delMany = delMany;
  exports.entries = entries;
  exports.get = get;
  exports.getMany = getMany;
  exports.keys = keys;
  exports.promisifyRequest = promisifyRequest;
  exports.set = set;
  exports.setMany = setMany;
  exports.update = update;
  exports.values = values;

  return exports;
})({});
