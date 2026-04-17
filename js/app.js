'use strict';

// ─── APP.JS ───────────────────────────────────────────────────────────────────
// Controlador principal de CapDispatch.
// Maneja todas las pantallas, el flujo de ventas y la lógica de negocio.
// Depende de: config.js, idb.js, cost.js, sync.js, auth.js

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────
const App = {
  user:             null,   // usuario logueado {id, name, role}
  cart:             [],     // [{productId, productName, quantity, unitPrice, costPerUnit}]
  products:         [],     // productos manufacturados activos
  prices:           {},     // {productId: price}
  customers:        [],     // clientes para búsqueda
  investorData:     null,   // {id, clientId, totalDebt} | null
  selectedCustomer: null,   // {id, name, isInvestor}
  paymentMethod:    'cash',
  pendingCount:     0,
  operators:        [],     // operarios de CapFlow para mostrar nombres en producción
  transferAccounts: [],     // cuentas de transferencia activas
  activeModal:      null,   // 'quantity' | 'customer' | null
  editProduct:      null,   // producto seleccionado para agregar al carrito
  editQty:          1,
  editPrice:        900,
};


// ─── CIERRE AUTOMÁTICO POR INACTIVIDAD ───────────────────────────────────────

const INACTIVITY_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutos
let _inactivityTimer = null;

function startInactivityTimer() {
  stopInactivityTimer();
  _inactivityTimer = setTimeout(() => {
    if (!App.user) return;
    showToast('Sesión cerrada por inactividad', 'warning');
    logout();
    renderPinScreen();
  }, INACTIVITY_TIMEOUT_MS);
}

function stopInactivityTimer() {
  if (_inactivityTimer) {
    clearTimeout(_inactivityTimer);
    _inactivityTimer = null;
  }
}

function resetInactivityTimer() {
  if (!App.user) return;
  startInactivityTimer();
}
