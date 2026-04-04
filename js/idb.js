// ─── INDEXEDDB MANAGER ───────────────────────────────────────────────────────
// Maneja todo el almacenamiento local de la app.
//
// Stores:
//   pending_sales  → ventas creadas offline, esperando sincronización
//   app_cache      → caché de datos de Supabase (productos, clientes, precios,
//                    datos de costo, inversionista)

const DB_NAME    = 'capdispatch-db';
const DB_VERSION = 1;

let _db = null;

// ─── INIT ─────────────────────────────────────────────────────────────────────
// Abre (o crea) la base de datos local.
// Se llama una sola vez al arrancar la app.
function idbOpen() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = event => {
      const db = event.target.result;

      // Store para ventas pendientes de sincronizar
      if (!db.objectStoreNames.contains('pending_sales')) {
        const store = db.createObjectStore('pending_sales', { keyPath: 'id' });
        store.createIndex('created_at', 'created_at');
      }

      // Store para caché general de datos remotos
      // Clave: string descriptivo (ej: 'products', 'customers', 'prices', etc.)
      // Valor: { key, data, cached_at }
      if (!db.objectStoreNames.contains('app_cache')) {
        db.createObjectStore('app_cache', { keyPath: 'key' });
      }
    };

    request.onsuccess = event => {
      _db = event.target.result;
      resolve(_db);
    };

    request.onerror = event => {
      console.error('Error abriendo IndexedDB:', event.target.error);
      reject(event.target.error);
    };
  });
}

// ─── HELPER: transacción genérica ────────────────────────────────────────────
function idbTx(storeName, mode = 'readonly') {
  return _db.transaction(storeName, mode).objectStore(storeName);
}

// ─── CACHE ────────────────────────────────────────────────────────────────────

// Guarda un dato en caché
// key: string identificador  |  data: cualquier valor serializable
function cacheSet(key, data) {
  return new Promise((resolve, reject) => {
    const store = idbTx('app_cache', 'readwrite');
    const request = store.put({ key, data, cached_at: Date.now() });
    request.onsuccess = () => resolve();
    request.onerror  = e  => reject(e.target.error);
  });
}

// Lee un dato del caché. Devuelve null si no existe.
function cacheGet(key) {
  return new Promise((resolve, reject) => {
    const store = idbTx('app_cache', 'readonly');
    const request = store.get(key);
    request.onsuccess = e => resolve(e.target.result ? e.target.result.data : null);
    request.onerror   = e => reject(e.target.error);
  });
}

// ─── VENTAS PENDIENTES ────────────────────────────────────────────────────────

// Guarda una venta pendiente de sincronizar
function pendingSaleAdd(sale) {
  return new Promise((resolve, reject) => {
    const store = idbTx('pending_sales', 'readwrite');
    // Marca el estado de sincronización
    const record = { ...sale, sync_status: 'pending', created_at: Date.now() };
    const request = store.add(record);
    request.onsuccess = () => resolve();
    request.onerror   = e  => reject(e.target.error);
  });
}

// Devuelve todas las ventas pendientes, ordenadas por fecha de creación
function pendingSaleGetAll() {
  return new Promise((resolve, reject) => {
    const store = idbTx('pending_sales', 'readonly');
    const request = store.index('created_at').getAll();
    request.onsuccess = e => resolve(e.target.result || []);
    request.onerror   = e => reject(e.target.error);
  });
}

// Marca una venta pendiente como sincronizada y la elimina del store
function pendingSaleRemove(id) {
  return new Promise((resolve, reject) => {
    const store = idbTx('pending_sales', 'readwrite');
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror   = e  => reject(e.target.error);
  });
}

// Marca una venta como fallida (para mostrarle al supervisor)
function pendingSaleMarkFailed(id, errorMessage) {
  return new Promise((resolve, reject) => {
    const store = idbTx('pending_sales', 'readwrite');
    const getRequest = store.get(id);
    getRequest.onsuccess = e => {
      const record = e.target.result;
      if (!record) return resolve();
      record.sync_status  = 'failed';
      record.sync_error   = errorMessage;
      record.failed_at    = Date.now();
      const putRequest = idbTx('pending_sales', 'readwrite').put(record);
      putRequest.onsuccess = () => resolve();
      putRequest.onerror   = e  => reject(e.target.error);
    };
    getRequest.onerror = e => reject(e.target.error);
  });
}

// Devuelve el total de ventas pendientes (para el badge del supervisor)
function pendingSaleCount() {
  return new Promise((resolve, reject) => {
    const store = idbTx('pending_sales', 'readonly');
    const request = store.count();
    request.onsuccess = e => resolve(e.target.result);
    request.onerror   = e => reject(e.target.error);
  });
}
