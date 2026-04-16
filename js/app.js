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

// ─── UTILIDADES DE UI ─────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function fmt(amount) {
  return `RD$${Number(amount).toLocaleString('es-DO', { minimumFractionDigits: 0 })}`;
}

function showToast(message, type = 'success') {
  const existing = document.querySelector('.cd-toast');
  if (existing) existing.remove();

  const colors = {
    success: 'bg-green-500',
    error:   'bg-red-500',
    warning: 'bg-yellow-500',
    info:    'bg-blue-500',
  };

  const toast = document.createElement('div');
  toast.className = `cd-toast fixed top-4 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-xl text-white text-sm font-medium shadow-lg transition-all ${colors[type] || colors.info}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function setConnectionBadge() {
  const badge = $('connection-badge');
  if (!badge) return;
  if (navigator.onLine) {
    badge.textContent = 'En línea';
    badge.className = 'text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium';
  } else {
    badge.textContent = 'Sin conexión';
    badge.className = 'text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 font-medium';
  }
}

// ─── CARGA DE DATOS ───────────────────────────────────────────────────────────

async function loadAppData() {
  // Productos manufacturados
  const prodCached = await cacheGet('products');
  if (prodCached) App.products = prodCached;

  const { data: prodData, error: prodErr } = await supabaseRequest(
    'products?type=eq.manufactured&active=eq.true&select=id,name,type'
  );
  if (!prodErr && prodData) {
    App.products = prodData;
    await cacheSet('products', prodData);
  }

  // Precios por defecto
  const priceCached = await cacheGet('prices');
  if (priceCached) App.prices = priceCached;

  const { data: priceData, error: priceErr } = await supabaseRequest(
    'dispatch_product_prices?select=product_id,default_price'
  );
  if (!priceErr && priceData) {
    const map = {};
    priceData.forEach(p => { map[p.product_id] = Number(p.default_price); });
    App.prices = map;
    await cacheSet('prices', map);
  }

  // Clientes (para búsqueda)
  const custCached = await cacheGet('customers');
  if (custCached) App.customers = custCached;

  const { data: custData, error: custErr } = await supabaseRequest(
    `customers?status=eq.active&select=id,name,type&order=name.asc`
  );
  if (!custErr && custData) {
    App.customers = custData;
    await cacheSet('customers', custData);
  }

  // Inversionista
  const invCached = await cacheGet('investor');
  if (invCached) App.investorData = invCached;

  const { data: invData, error: invErr } = await supabaseRequest(
    'investor?select=id,client_id,total_debt&limit=1'
  );
  if (!invErr && invData && invData.length > 0) {
    App.investorData = invData[0];
    await cacheSet('investor', invData[0]);
  }

  // Conteo de ventas pendientes
  App.pendingCount = await pendingSaleCount();

  // Cuentas de transferencia
  const taCached = await cacheGet('transfer_accounts');
  if (taCached) App.transferAccounts = taCached;

  const { data: taData, error: taErr } = await supabaseRequest(
    'dispatch_transfer_accounts?is_active=eq.true&select=id,bank_name,account_number,account_holder,id_number&order=created_at.asc'
  );
  if (!taErr && taData) {
    App.transferAccounts = taData;
    await cacheSet('transfer_accounts', taData);
  }

  // Operarios de CapFlow (para pantalla de producción)
  const opsCached = await cacheGet('capflow_operators');
  if (opsCached) App.operators = opsCached;

  const { data: opsData, error: opsErr } = await supabaseRequest(
    'operators?is_active=eq.true&select=id,name'
  );
  if (!opsErr && opsData) {
    App.operators = opsData;
    await cacheSet('capflow_operators', opsData);
  }
}

// ─── PANTALLA: PIN ────────────────────────────────────────────────────────────

function renderPinScreen() {
  stopInactivityTimer();
  App.user = null;
  $('app').innerHTML = `
    <div class="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6">
      <div class="w-full max-w-sm">

        <div class="text-center mb-8">
          <div class="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl mb-4 shadow-lg">
            <span class="text-white text-2xl font-bold">CD</span>
          </div>
          <h1 class="text-2xl font-bold text-gray-800">CapDispatch</h1>
          <p class="text-gray-400 text-sm mt-1">Ingresa tu PIN para continuar</p>
        </div>

        <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-4">
          <div id="pin-dots" class="flex justify-center gap-3 mb-6 min-h-[2rem] items-center">
            <span class="text-gray-300 text-sm">— — — —</span>
          </div>
          <div id="pin-error" class="hidden text-red-500 text-sm text-center mb-3 font-medium"></div>

          <div class="grid grid-cols-3 gap-3">
            ${[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map(k => `
              <button
                data-key="${k}"
                class="${k === '' ? 'invisible' : 'pin-key bg-gray-50 hover:bg-blue-50 active:bg-blue-100 border border-gray-200 rounded-xl py-4 text-xl font-semibold text-gray-700 transition-colors select-none'}"
              >${k}</button>
            `).join('')}
          </div>

          <button id="pin-submit"
            class="w-full mt-4 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold py-4 rounded-xl transition-colors text-lg">
            Entrar
          </button>
        </div>

      </div>
    </div>
  `;

  let pin = '';
  let isValidating = false;

  function updateDots() {
    const dots = $('pin-dots');
    if (pin.length === 0) {
      dots.innerHTML = '<span class="text-gray-300 text-sm">— — — —</span>';
    } else {
      dots.innerHTML = pin.split('').map(() =>
        '<div class="w-3 h-3 rounded-full bg-blue-600"></div>'
      ).join('');
    }
  }

  function showError(msg) {
    const el = $('pin-error');
    el.textContent = msg;
    el.classList.remove('hidden');
    pin = '';
    updateDots();
  }

  async function submitPin() {
    if (pin.length === 0 || isValidating) return;
    const btn = $('pin-submit');
    btn.textContent = 'Verificando...';
    btn.disabled = true;
    isValidating = true;

    const result = await validatePin(pin);
    if (result.success) {
      App.user = result.user;
      await loadAppData();
      renderWindowSelectionMenu();
    } else {
      showError(result.error || 'PIN incorrecto');
      btn.textContent = 'Entrar';
      btn.disabled = false;
    }
    isValidating = false;
  }

  // Intenta validar silenciosamente después de cada dígito (mínimo 4)
  // Si es válido → login automático. Si no → espera sin mostrar error.
  async function tryAutoLogin() {
    if (pin.length < 4 || isValidating) return;
    isValidating = true;

    const result = await validatePin(pin);
    if (result.success) {
      App.user = result.user;
      await loadAppData();
      renderWindowSelectionMenu();
    }
    // Si no es válido, simplemente no hace nada — el usuario sigue escribiendo
    // o presiona "Entrar" para ver el error
    isValidating = false;
  }

  document.querySelectorAll('.pin-key').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (key === '⌫') {
        pin = pin.slice(0, -1);
        $('pin-error').classList.add('hidden');
        updateDots();
      } else if (pin.length < 8) {
        pin += key;
        $('pin-error').classList.add('hidden');
        updateDots();
        tryAutoLogin();
      }
    });
  });

  $('pin-submit').addEventListener('click', submitPin);
}

// ─── COLORES POR PRODUCTO ─────────────────────────────────────────────────────
// Mapea el nombre del producto a colores para la tarjeta.
// Devuelve { border, bg, dot, text } en formato de estilos inline.

function getProductColor(name) {
  const n = name.toLowerCase();
  if (n.includes('roja') || n.includes('rojo'))
    return { border: '#ef4444', bg: 'rgba(239,68,68,0.07)',   dot: '#ef4444', text: '#b91c1c' };
  if (n.includes('rosada') || n.includes('rosado') || n.includes('rosa'))
    return { border: '#ec4899', bg: 'rgba(236,72,153,0.07)',  dot: '#ec4899', text: '#9d174d' };
  if (n.includes('naranja'))
    return { border: '#f97316', bg: 'rgba(249,115,22,0.07)',  dot: '#f97316', text: '#c2410c' };
  if (n.includes('verde'))
    return { border: '#22c55e', bg: 'rgba(34,197,94,0.07)',   dot: '#22c55e', text: '#15803d' };
  if (n.includes('argolla'))
    return { border: '#6366f1', bg: 'rgba(99,102,241,0.07)',  dot: '#6366f1', text: '#4338ca' };
  if (n.includes('azul'))
    return { border: '#3b82f6', bg: 'rgba(59,130,246,0.07)',  dot: '#3b82f6', text: '#1d4ed8' };
  return   { border: '#64748b', bg: 'rgba(100,116,139,0.07)', dot: '#64748b', text: '#334155' };
}

// ─── PANTALLA: PRODUCTOS ──────────────────────────────────────────────────────

// ─── PANTALLA: MENÚ DE VENTANAS ───────────────────────────────────────────────

function renderWindowSelectionMenu() {
  startInactivityTimer();
  const isSup = App.user?.role === ROLES.SUPERVISOR;

  $('app').innerHTML = `
    <div class="min-h-screen bg-gray-50 flex flex-col">

      <!-- Header -->
      <header class="bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <span class="text-white text-xs font-bold">CD</span>
          </div>
          <div>
            <p class="text-sm font-semibold text-gray-800">${App.user?.name}</p>
            <span id="connection-badge" class="text-xs"></span>
          </div>
        </div>
        <button id="logout-btn" class="p-3 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors" title="Cerrar sesión">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
          </svg>
        </button>
      </header>

      <!-- Opciones -->
      <main class="flex-1 p-5 flex flex-col gap-4">

        <p class="text-xs text-gray-400 uppercase font-semibold tracking-wide">Selecciona una ventana</p>

        <!-- Despacho -->
        <button id="menu-despacho"
          class="w-full text-left bg-white rounded-2xl border-2 border-blue-200 shadow-sm p-5 flex items-center gap-4 hover:border-blue-400 hover:bg-blue-50 active:scale-95 transition-all">
          <div class="w-12 h-12 rounded-xl bg-blue-100 flex items-center justify-center flex-shrink-0">
            <svg class="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-base font-bold text-gray-800">Despacho</p>
            <p class="text-sm text-gray-400 mt-0.5">Registrar ventas de productos</p>
          </div>
          <svg class="w-5 h-5 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>

        <!-- Panel de supervisor — solo visible para supervisores -->
        ${isSup ? `
        <button id="menu-supervisor"
          class="w-full text-left bg-white rounded-2xl border-2 border-purple-200 shadow-sm p-5 flex items-center gap-4 hover:border-purple-400 hover:bg-purple-50 active:scale-95 transition-all">
          <div class="w-12 h-12 rounded-xl bg-purple-100 flex items-center justify-center flex-shrink-0">
            <svg class="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-base font-bold text-gray-800">Panel de supervisor</p>
            <p class="text-sm text-gray-400 mt-0.5">Ventas, operarios, precios y cuentas</p>
          </div>
          <svg class="w-5 h-5 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>
        ` : ''}

        <!-- Sección: Peso y producción -->
        <p class="text-xs text-gray-400 uppercase font-semibold tracking-wide mt-1">Peso y producción</p>

        <button id="menu-materia"
          class="w-full text-left bg-white rounded-2xl border-2 border-orange-200 shadow-sm p-5 flex items-center gap-4 hover:border-orange-400 hover:bg-orange-50 active:scale-95 transition-all">
          <div class="w-12 h-12 rounded-xl bg-orange-100 flex items-center justify-center flex-shrink-0">
            <svg class="w-6 h-6 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-base font-bold text-gray-800">Entrada de materia prima</p>
            <p class="text-sm text-gray-400 mt-0.5">Registrar reciclado, pellet y colorante</p>
          </div>
          <svg class="w-5 h-5 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>

        <button id="menu-peso"
          class="w-full text-left bg-white rounded-2xl border-2 border-teal-200 shadow-sm p-5 flex items-center gap-4 hover:border-teal-400 hover:bg-teal-50 active:scale-95 transition-all">
          <div class="w-12 h-12 rounded-xl bg-teal-100 flex items-center justify-center flex-shrink-0">
            <svg class="w-6 h-6 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3"/>
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-base font-bold text-gray-800">Peso de paquete</p>
            <p class="text-sm text-gray-400 mt-0.5">Registrar el peso de 1,000 tapas del turno</p>
          </div>
          <svg class="w-5 h-5 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>

        <button id="menu-produccion"
          class="w-full text-left bg-white rounded-2xl border-2 border-green-200 shadow-sm p-5 flex items-center gap-4 hover:border-green-400 hover:bg-green-50 active:scale-95 transition-all">
          <div class="w-12 h-12 rounded-xl bg-green-100 flex items-center justify-center flex-shrink-0">
            <svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-base font-bold text-gray-800">Producción</p>
            <p class="text-sm text-gray-400 mt-0.5">Ver el reporte mensual de producción</p>
          </div>
          <svg class="w-5 h-5 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>

        <button id="menu-tapas"
          class="w-full text-left bg-white rounded-2xl border-2 border-purple-200 shadow-sm p-5 flex items-center gap-4 hover:border-purple-400 hover:bg-purple-50 active:scale-95 transition-all">
          <div class="w-12 h-12 rounded-xl bg-purple-100 flex items-center justify-center flex-shrink-0">
            <svg class="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-base font-bold text-gray-800">Registrar tapas del día</p>
            <p class="text-sm text-gray-400 mt-0.5">Ingresar tapas producidas por color y cantidad</p>
          </div>
          <svg class="w-5 h-5 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>

      </main>
    </div>
  `;

  setConnectionBadge();
  $('logout-btn').addEventListener('click', () => { logout(); renderPinScreen(); });
  $('menu-despacho').addEventListener('click', renderProductsScreen);
  if (isSup) $('menu-supervisor').addEventListener('click', renderSupervisorPanel);
  $('menu-materia').addEventListener('click', () => renderMaterialEntryScreen());
  $('menu-peso').addEventListener('click', () => renderPackageWeightScreen());
  $('menu-produccion').addEventListener('click', () => renderProductionScreen());
  $('menu-tapas').addEventListener('click', () => renderDailyProductionScreen());
}

// ─── PANTALLA: DESPACHO (PRODUCTOS) ──────────────────────────────────────────

function renderProductsScreen() {
  const cartCount  = App.cart.reduce((s, i) => s + i.quantity, 0);
  const cartTotal  = App.cart.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const isSup      = App.user?.role === ROLES.SUPERVISOR;
  const pendBadge  = App.pendingCount > 0
    ? `<span class="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center">${App.pendingCount}</span>`
    : '';

  $('app').innerHTML = `
    <div class="min-h-screen bg-gray-50 flex flex-col">

      <!-- Header -->
      <header class="bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div class="flex items-center gap-3">
          <button id="back-btn" class="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors flex-shrink-0">←</button>
          <div>
            <p class="text-sm font-semibold text-gray-800">${App.user?.name}</p>
            <span id="connection-badge" class="text-xs"></span>
          </div>
        </div>
        <button id="logout-btn" class="p-3 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
          </svg>
        </button>
      </header>

      <!-- Grid de productos -->
      <main class="flex-1 p-4 pb-36">
        <p class="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-4">Selecciona un producto</p>
        <div class="grid grid-cols-2 gap-4">
          ${App.products.map(p => {
            const price  = App.prices[p.id] || DEFAULT_PRODUCT_PRICE;
            const inCart = App.cart.find(c => c.productId === p.id);
            const color  = getProductColor(p.name);
            const cardBorder = inCart ? color.border : '#e5e7eb';
            const cardBg     = inCart ? color.bg : '#ffffff';
            return `
              <button data-product-id="${p.id}" class="product-card text-left active:scale-95 transition-all rounded-2xl overflow-hidden shadow-sm"
                style="border: 2.5px solid ${cardBorder}; background: ${cardBg};">
                <!-- Barra de color superior -->
                <div style="height: 8px; background: ${color.border};"></div>
                <div class="p-4">
                  <!-- Indicador de color + nombre -->
                  <div class="flex items-center gap-2 mb-3">
                    <div class="w-4 h-4 rounded-full flex-shrink-0" style="background: ${color.dot};"></div>
                    <p class="font-bold text-gray-800 text-base leading-tight">${p.name}</p>
                  </div>
                  <!-- Precio -->
                  <p class="text-2xl font-extrabold mb-2" style="color: ${color.text};">${fmt(price)}</p>
                  <!-- Estado carrito -->
                  ${inCart
                    ? `<div class="flex items-center gap-1.5 mt-1">
                         <div class="w-2 h-2 rounded-full" style="background:${color.border};"></div>
                         <span class="text-sm font-semibold" style="color:${color.text};">${inCart.quantity} en carrito</span>
                       </div>`
                    : `<p class="text-xs text-gray-400 font-medium">Toca para agregar</p>`
                  }
                </div>
              </button>`;
          }).join('')}
        </div>
      </main>

      <!-- Barra del carrito -->
      <div id="cart-bar" class="fixed bottom-0 left-0 right-0 bg-white border-t-2 border-gray-100 shadow-lg px-4 py-4">
        ${App.cart.length === 0 ? `
          <div class="flex items-center justify-center py-1">
            <p class="text-gray-300 text-base font-medium">Carrito vacío</p>
          </div>
        ` : `
          <div class="flex items-center justify-between gap-3">
            <div class="flex-1 min-w-0">
              <p class="text-sm text-gray-400 font-medium">${cartCount} ${cartCount === 1 ? 'paquete' : 'paquetes'}</p>
              <p class="text-2xl font-extrabold text-gray-800 leading-tight">${fmt(cartTotal)}</p>
            </div>
            <div class="flex gap-2 flex-shrink-0">
              <button id="clear-cart-btn"
                class="px-4 py-3 rounded-xl border-2 border-gray-200 text-gray-500 text-sm font-semibold hover:bg-gray-50 transition-colors">
                Limpiar
              </button>
              <button id="checkout-btn"
                class="px-6 py-3 rounded-xl bg-blue-600 text-white text-base font-bold hover:bg-blue-700 active:bg-blue-800 transition-colors shadow-sm">
                Cobrar →
              </button>
            </div>
          </div>
        `}
      </div>

    </div>
  `;

  setConnectionBadge();

  // Eventos
  document.querySelectorAll('.product-card').forEach(btn => {
    btn.addEventListener('click', () => {
      const productId = btn.dataset.productId;
      const product   = App.products.find(p => p.id === productId);
      if (!product) return;
      App.editProduct = product;
      App.editQty     = 1;
      App.editPrice   = App.prices[productId] || DEFAULT_PRODUCT_PRICE;
      renderQuantityModal();
    });
  });

  $('back-btn').addEventListener('click', renderWindowSelectionMenu);
  $('logout-btn').addEventListener('click', () => { logout(); renderPinScreen(); });

  if (App.cart.length > 0) {
    $('clear-cart-btn').addEventListener('click', () => {
      App.cart = [];
      renderProductsScreen();
    });
    $('checkout-btn').addEventListener('click', renderCustomerScreen);
  }

  window.addEventListener('online',  setConnectionBadge);
  window.addEventListener('offline', setConnectionBadge);

  onSyncUpdate(async () => {
    App.pendingCount = await pendingSaleCount();
    setConnectionBadge();
  });
}

// ─── MODAL: CANTIDAD ──────────────────────────────────────────────────────────

function renderQuantityModal() {
  const existing = document.querySelector('.cd-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'cd-modal fixed inset-0 bg-black/40 z-30 flex items-end justify-center';

  overlay.innerHTML = `
    <div class="bg-white w-full max-w-lg rounded-t-3xl p-6 shadow-xl">
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-lg font-bold text-gray-800">${App.editProduct.name}</h2>
        <button id="modal-close" class="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors">✕</button>
      </div>

      <!-- Precio -->
      <div class="mb-5">
        <label class="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1 block">Precio por paquete</label>
        <div class="flex items-center gap-2">
          <span class="text-gray-400 font-medium">RD$</span>
          <input id="price-input" type="number" value="${App.editPrice}" min="0"
            class="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-lg font-bold text-gray-800 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-300"/>
        </div>
      </div>

      <!-- Cantidad -->
      <div class="mb-6">
        <label class="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1 block">Cantidad</label>
        <div class="flex items-center gap-4">
          <button id="qty-minus" class="w-12 h-12 rounded-xl border border-gray-200 text-xl font-bold text-gray-600 hover:bg-gray-50 active:bg-gray-100 transition-colors flex items-center justify-center">−</button>
          <span id="qty-display" class="text-3xl font-bold text-gray-800 w-12 text-center">${App.editQty}</span>
          <button id="qty-plus"  class="w-12 h-12 rounded-xl border border-gray-200 text-xl font-bold text-gray-600 hover:bg-gray-50 active:bg-gray-100 transition-colors flex items-center justify-center">+</button>
          <div class="flex-1">
            <p class="text-xs text-gray-400">Subtotal</p>
            <p id="subtotal-display" class="text-lg font-bold text-blue-600">${fmt(App.editPrice * App.editQty)}</p>
          </div>
        </div>
      </div>

      <button id="add-to-cart-btn"
        class="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold py-4 rounded-xl transition-colors text-base">
        Agregar al carrito
      </button>
    </div>
  `;

  document.body.appendChild(overlay);

  function updateModal() {
    const price = Number($('price-input').value) || 0;
    App.editPrice = price;
    $('qty-display').textContent  = App.editQty;
    $('subtotal-display').textContent = fmt(price * App.editQty);
  }

  $('modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  $('qty-minus').addEventListener('click', () => {
    if (App.editQty > 1) { App.editQty--; updateModal(); }
  });
  $('qty-plus').addEventListener('click', () => {
    App.editQty++;
    updateModal();
  });
  $('price-input').addEventListener('input', updateModal);

  $('add-to-cart-btn').addEventListener('click', () => {
    const price = Number($('price-input').value) || 0;
    const existing = App.cart.findIndex(c => c.productId === App.editProduct.id);

    if (existing >= 0) {
      App.cart[existing].quantity  = App.editQty;
      App.cart[existing].unitPrice = price;
    } else {
      App.cart.push({
        productId:   App.editProduct.id,
        productName: App.editProduct.name,
        quantity:    App.editQty,
        unitPrice:   price,
        costPerUnit: 0, // se calcula al guardar la venta
      });
    }

    overlay.remove();
    renderProductsScreen();
  });
}

// ─── PANTALLA: CLIENTE ────────────────────────────────────────────────────────

function renderCustomerScreen() {
  $('app').innerHTML = `
    <div class="min-h-screen bg-gray-50 flex flex-col">
      <header class="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 sticky top-0 z-10 shadow-sm">
        <button id="back-btn" class="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors">←</button>
        <h1 class="text-base font-bold text-gray-800">¿Quién compra?</h1>
      </header>

      <main class="flex-1 p-4">
        <!-- Cliente genérico -->
        <button id="generic-btn"
          class="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold py-5 rounded-2xl mb-4 text-base transition-colors shadow-sm">
          Cliente Genérico / Contado
        </button>

        <div class="relative mb-3">
          <input id="customer-search" type="text" placeholder="Buscar cliente por nombre..."
            class="w-full border border-gray-200 rounded-xl px-4 py-3 pl-9 text-sm focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-300 bg-white"/>
          <svg class="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
        </div>

        <div id="customer-list" class="space-y-2"></div>
      </main>
    </div>
  `;

  function renderCustomers(list) {
    const el = $('customer-list');
    if (list.length === 0) {
      el.innerHTML = '<p class="text-center text-gray-400 text-sm py-4">No se encontraron clientes</p>';
      return;
    }
    el.innerHTML = list
      .filter(c => c.id !== GENERIC_CUSTOMER_ID)
      .slice(0, 20)
      .map(c => {
        const isInvestor = App.investorData && App.investorData.client_id === c.id;
        return `
          <button data-customer-id="${c.id}" data-customer-name="${c.name}" data-is-investor="${isInvestor}"
            class="customer-item w-full bg-white border border-gray-100 rounded-xl px-4 py-3 text-left hover:border-blue-300 hover:bg-blue-50 active:bg-blue-100 transition-all flex items-center justify-between">
            <div>
              <p class="font-medium text-gray-800 text-sm">${c.name}</p>
              <p class="text-xs text-gray-400">${c.type === 'company' ? 'Empresa' : 'Individual'}</p>
            </div>
            ${isInvestor ? '<span class="text-xs bg-purple-100 text-purple-600 px-2 py-0.5 rounded-full font-medium">Inversionista</span>' : ''}
          </button>`;
      }).join('');

    document.querySelectorAll('.customer-item').forEach(btn => {
      btn.addEventListener('click', () => {
        App.selectedCustomer = {
          id:         btn.dataset.customerId,
          name:       btn.dataset.customerName,
          isInvestor: btn.dataset.isInvestor === 'true',
        };
        renderPaymentScreen();
      });
    });
  }

  $('back-btn').addEventListener('click', renderProductsScreen);

  $('generic-btn').addEventListener('click', () => {
    App.selectedCustomer = { id: GENERIC_CUSTOMER_ID, name: 'Genérico', isInvestor: false };
    renderPaymentScreen();
  });

  $('customer-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    if (q.length === 0) { renderCustomers([]); return; }
    renderCustomers(App.customers.filter(c => c.name.toLowerCase().includes(q)));
  });
}

// ─── PANTALLA: PAGO ───────────────────────────────────────────────────────────

function renderPaymentScreen() {
  const isInvestor = App.selectedCustomer?.isInvestor && App.investorData;
  if (isInvestor) App.paymentMethod = 'transfer';
  let remainingDebt = isInvestor ? Number(App.investorData.total_debt) || 0 : 0;

  let totalRevenue = 0, totalBenefitDiscount = 0, totalAmortization = 0;

  const linesSummary = App.cart.map(item => {
    let discount = 0, amort = 0;
    if (isInvestor) {
      discount = 100 * item.quantity;
      amort    = Math.min(100 * item.quantity, remainingDebt);
      remainingDebt -= amort;
      totalBenefitDiscount += discount;
      totalAmortization    += amort;
    }
    const lineRevenue = (item.unitPrice * item.quantity) - discount - amort;
    totalRevenue += lineRevenue;
    return { ...item, discount, amort, lineRevenue };
  });

  $('app').innerHTML = `
    <div class="min-h-screen bg-gray-50 flex flex-col">
      <header class="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 sticky top-0 z-10 shadow-sm">
        <button id="back-btn" class="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors">←</button>
        <div>
          <h1 class="text-base font-bold text-gray-800">Confirmar venta</h1>
          <p class="text-xs text-gray-400">${App.selectedCustomer?.name}</p>
        </div>
      </header>

      <main class="flex-1 p-4">
        <!-- Resumen de productos -->
        <div class="bg-white rounded-2xl border border-gray-100 shadow-sm mb-4 overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-100">
            <p class="text-xs text-gray-400 uppercase font-semibold tracking-wide">Productos a despachar</p>
          </div>
          ${linesSummary.map(item => `
            <div class="px-4 py-4 border-b border-gray-50 last:border-0">
              <div class="flex items-center justify-between">
                <p class="text-lg font-bold text-gray-800">${item.productName}</p>
                ${!isInvestor ? `<p class="text-lg font-bold text-gray-800">${fmt(item.lineRevenue)}</p>` : ''}
              </div>
              <div class="mt-2 inline-flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-xl px-3 py-1.5">
                <svg class="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                </svg>
                <span class="text-blue-700 font-extrabold text-base">${item.quantity} ${item.quantity === 1 ? 'paquete' : 'paquetes'}</span>
              </div>
            </div>
          `).join('')}
        </div>

        ${isInvestor ? `
          <div class="bg-purple-50 border border-purple-100 rounded-xl px-4 py-3 mb-4 text-sm">
            <p class="font-semibold text-purple-700">Precio especial aplicado ✓</p>
          </div>
        ` : ''}

        <!-- Total (solo para clientes normales) -->
        ${!isInvestor ? `
          <div class="bg-white rounded-2xl border border-gray-100 shadow-sm mb-4 px-4 py-4 flex items-center justify-between">
            <p class="font-semibold text-gray-600">Total a cobrar</p>
            <p class="text-2xl font-bold text-blue-600">${fmt(totalRevenue)}</p>
          </div>
        ` : ''}

        <!-- Método de pago (solo para clientes normales) -->
        ${!isInvestor ? `
        <div class="bg-white rounded-2xl border border-gray-100 shadow-sm mb-4 p-4">
          <p class="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-3">Método de pago</p>
          <div class="grid grid-cols-2 gap-2">
            <button id="pay-cash"
              class="py-3 rounded-xl border-2 font-semibold text-sm transition-colors ${App.paymentMethod === 'cash' ? 'border-blue-500 bg-blue-50 text-blue-600' : 'border-gray-200 text-gray-500 hover:border-gray-300'}">
              💵 Efectivo
            </button>
            <button id="pay-transfer"
              class="py-3 rounded-xl border-2 font-semibold text-sm transition-colors ${App.paymentMethod === 'transfer' ? 'border-blue-500 bg-blue-50 text-blue-600' : 'border-gray-200 text-gray-500 hover:border-gray-300'}">
              📲 Transferencia
            </button>
          </div>
        </div>
        ` : ''}

        <!-- Cuentas de transferencia -->
        ${App.paymentMethod === 'transfer' && App.transferAccounts.length > 0 ? `
        <div class="bg-white rounded-2xl border border-gray-100 shadow-sm mb-4 overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-100">
            <p class="text-xs text-gray-400 uppercase font-semibold tracking-wide">Datos para transferencia</p>
          </div>
          ${App.transferAccounts.map(acc => `
            <div class="px-4 py-4 border-b border-gray-50 last:border-0">
              <p class="text-base font-extrabold text-gray-800 mb-3">${acc.bank_name}</p>
              <div class="space-y-2">
                <div class="flex items-center justify-between">
                  <p class="text-xs text-gray-400 uppercase font-semibold">No. Cuenta</p>
                  <p class="text-lg font-extrabold text-gray-800 tracking-wide">${acc.account_number}</p>
                </div>
                <div class="flex items-center justify-between">
                  <p class="text-xs text-gray-400 uppercase font-semibold">Nombre</p>
                  <p class="text-base font-bold text-gray-700">${acc.account_holder}</p>
                </div>
                <div class="flex items-center justify-between">
                  <p class="text-xs text-gray-400 uppercase font-semibold">Cédula</p>
                  <p class="text-base font-bold text-gray-700">${acc.id_number}</p>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
        ` : ''}

        <button id="confirm-btn"
          class="w-full bg-green-500 hover:bg-green-600 active:bg-green-700 text-white font-bold py-5 rounded-2xl text-lg transition-colors shadow-sm">
          Confirmar venta
        </button>
      </main>
    </div>
  `;

  $('back-btn').addEventListener('click', renderCustomerScreen);

  if (!isInvestor) {
    $('pay-cash').addEventListener('click', () => {
      App.paymentMethod = 'cash';
      renderPaymentScreen();
    });
    $('pay-transfer').addEventListener('click', () => {
      App.paymentMethod = 'transfer';
      renderPaymentScreen();
    });
  }

  $('confirm-btn').addEventListener('click', async () => {
    $('confirm-btn').textContent = 'Guardando...';
    $('confirm-btn').disabled = true;
    await processSale(totalRevenue, totalBenefitDiscount, totalAmortization, linesSummary);
  });
}

// ─── LÓGICA DE VENTA ──────────────────────────────────────────────────────────

async function processSale(totalRevenue, totalBenefitDiscount, totalAmortization, linesSummary) {
  const month = getCurrentMonth();

  // Calcular costo por paquete del mes
  const { costPerPackage } = await computeCostForMonth(month);

  // Construir lines array (formato CapFlow)
  let totalCost = 0;
  const lines = linesSummary.map(item => {
    const lineCost    = costPerPackage * item.quantity;
    const lineRevFull = item.unitPrice * item.quantity;
    const lineProfFull = lineRevFull - lineCost;
    totalCost += lineCost;
    return {
      quantity:              item.quantity,
      productId:             item.productId,
      unitPrice:             item.unitPrice,
      lineRevenue:           lineRevFull,
      lineCost,
      lineProfit:            lineProfFull,
      productType:           'manufactured',
      salePricePerUnit:      item.unitPrice,
      resaleCostPerUnit:     0,
      costPerUnitSnapshot:   costPerPackage,
      resaleCostPerUnitInput: 0,
    };
  });

  const actualProfit = totalRevenue - totalCost;
  const margin       = totalRevenue > 0 ? actualProfit / totalRevenue : 0;

  const totals = {
    revenue: totalRevenue,
    cost:    totalCost,
    profit:  actualProfit,
    margin,
    investor: {
      benefitDiscountTotal: totalBenefitDiscount,
      amortizationTotal:    totalAmortization,
    },
  };

  const isInvestor = App.selectedCustomer?.isInvestor && App.investorData;

  const sale = {
    id:              generateId('sale'),
    sale_date:       getCurrentDate(),
    month,
    client_id:       App.selectedCustomer.id,
    operator_id:     App.user.id,
    operator_name:   App.user.name,
    lines,
    totals,
    payment_method:  App.paymentMethod,
    notes:           `Despachado por ${App.user.name}`,
    is_investor:     !!isInvestor,
    investor_id:     isInvestor ? App.investorData.id : null,
    created_at:      Date.now(),
  };

  // Guardar siempre en IndexedDB primero
  await pendingSaleAdd(sale);
  App.pendingCount = await pendingSaleCount();

  // Si hay internet, sincronizar inmediatamente
  if (navigator.onLine) {
    const result = await syncPendingSales();
    if (result && result.synced > 0) {
      App.pendingCount = await pendingSaleCount();
      renderSuccessScreen(true);
    } else {
      renderSuccessScreen(false, 'Venta guardada. Se sincronizará cuando haya conexión.');
    }
  } else {
    renderSuccessScreen(false, 'Sin conexión. La venta se sincronizará automáticamente.');
  }

  // Limpiar estado
  App.cart             = [];
  App.selectedCustomer = null;
  App.paymentMethod    = 'cash';
}

// ─── PANTALLA: ÉXITO ──────────────────────────────────────────────────────────

function renderSuccessScreen(synced, offlineMsg = '') {
  $('app').innerHTML = `
    <div class="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6 text-center">
      <div class="w-20 h-20 ${synced ? 'bg-blue-100' : 'bg-yellow-100'} rounded-full flex items-center justify-center mb-5">
        <span class="text-4xl">${synced ? '📋' : '⏳'}</span>
      </div>
      <h2 class="text-2xl font-bold text-gray-800 mb-2">${synced ? 'Venta enviada para revisión' : 'Venta guardada'}</h2>
      <p class="text-gray-500 text-sm mb-8 max-w-xs">${synced ? 'La venta fue registrada y está pendiente de confirmación por el administrador en CapFlow.' : offlineMsg}</p>
      <button id="new-sale-btn"
        class="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-8 py-4 rounded-2xl text-base transition-colors shadow-sm">
        Nueva venta
      </button>
    </div>
  `;

  $('new-sale-btn').addEventListener('click', renderProductsScreen);
}

// ─── PANTALLA: PRODUCCIÓN ─────────────────────────────────────────────────────

async function renderProductionScreen(month = getCurrentMonth()) {
  const [year, monthNum] = month.split('-').map(Number);
  const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                      'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const monthLabel = `${monthNames[monthNum - 1]} ${year}`;

  $('app').innerHTML = `
    <div class="min-h-screen bg-gray-50 flex flex-col">
      <header class="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 sticky top-0 z-10 shadow-sm">
        <button id="back-btn" class="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors flex-shrink-0">←</button>
        <h1 class="text-base font-bold text-gray-800">Producción</h1>
      </header>

      <main class="flex-1 p-4">

        <!-- Navegación de mes -->
        <div class="bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-3 mb-4 flex items-center justify-between">
          <button id="prev-month" class="w-10 h-10 flex items-center justify-center rounded-xl bg-gray-100 text-gray-600 hover:bg-gray-200 active:bg-gray-300 transition-colors text-lg font-bold">‹</button>
          <p class="text-base font-bold text-gray-800">${monthLabel}</p>
          <button id="next-month" class="w-10 h-10 flex items-center justify-center rounded-xl bg-gray-100 text-gray-600 hover:bg-gray-200 active:bg-gray-300 transition-colors text-lg font-bold">›</button>
        </div>

        <!-- Tabla -->
        <div id="production-results">
          <div class="flex items-center justify-center py-12">
            <p class="text-gray-400 text-sm">Cargando...</p>
          </div>
        </div>

      </main>
    </div>
  `;

  $('back-btn').addEventListener('click', renderWindowSelectionMenu);

  $('prev-month').addEventListener('click', () => {
    const prev = monthNum === 1
      ? `${year - 1}-12`
      : `${year}-${String(monthNum - 1).padStart(2, '0')}`;
    renderProductionScreen(prev);
  });

  $('next-month').addEventListener('click', () => {
    const next = monthNum === 12
      ? `${year + 1}-01`
      : `${year}-${String(monthNum + 1).padStart(2, '0')}`;
    renderProductionScreen(next);
  });

  await loadProductionData(month);
}

async function loadProductionData(month) {
  const container = $('production-results');
  if (!container) return;

  const { data, error } = await supabaseRequest(
    `production?month=eq.${month}&select=production_date,operator_id,quantity&order=production_date.asc`
  );

  if (error) {
    container.innerHTML = `
      <div class="bg-red-50 border border-red-100 rounded-2xl px-4 py-4 text-center">
        <p class="text-red-500 text-sm font-medium">Error al cargar la producción</p>
      </div>`;
    return;
  }

  if (!data || data.length === 0) {
    container.innerHTML = `
      <div class="bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-10 text-center">
        <p class="text-2xl mb-2">📦</p>
        <p class="text-gray-500 font-medium">Sin producción registrada</p>
        <p class="text-gray-400 text-sm mt-1">No hay datos para este mes</p>
      </div>`;
    return;
  }

  // Construir mapa: { 'YYYY-MM-DD': { operatorId: totalQty } }
  const byDate = {};
  const operatorIds = new Set();

  data.forEach(row => {
    const date = row.production_date;
    const opId = row.operator_id;
    const qty  = Number(row.quantity) || 0;
    if (!byDate[date]) byDate[date] = {};
    byDate[date][opId] = (byDate[date][opId] || 0) + qty;
    operatorIds.add(opId);
  });

  // Resolver nombres — solo operarios que tienen producción ese mes (reporte mensual)
  const operators = [...operatorIds].map(id => {
    const op = App.operators.find(o => o.id === id);
    return { id, name: op?.name || 'Desconocido' };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const dates = Object.keys(byDate).sort();

  // Nombres de día en español
  const dayNames = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

  // Totales por operario (columna total)
  const opTotals = {};
  operators.forEach(op => {
    opTotals[op.id] = dates.reduce((s, d) => s + (byDate[d][op.id] || 0), 0);
  });

  const grandTotal = Object.values(opTotals).reduce((s, v) => s + v, 0);

  // Renderizar tabla con scroll horizontal
  container.innerHTML = `
    <div class="overflow-x-auto rounded-2xl border border-gray-100 shadow-sm bg-white">
      <table class="w-full text-sm border-collapse" style="min-width: ${180 + operators.length * 90}px;">
        <thead>
          <tr class="border-b-2 border-gray-100">
            <th class="text-left px-4 py-3 text-xs font-bold text-gray-400 uppercase tracking-wide sticky left-0 bg-white z-10 border-r border-gray-100" style="min-width:110px;">Fecha</th>
            ${operators.map(op => `
              <th class="px-3 py-3 text-center text-xs font-bold text-gray-600 uppercase tracking-wide" style="min-width:90px;">${op.name.split(' ')[0]}</th>
            `).join('')}
            <th class="px-3 py-3 text-center text-xs font-bold text-gray-400 uppercase tracking-wide" style="min-width:80px;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${dates.map((date, i) => {
            const d       = new Date(date + 'T12:00:00');
            const dayName = dayNames[d.getDay()];
            const dayNum  = d.getDate();
            const rowTotal = operators.reduce((s, op) => s + (byDate[date][op.id] || 0), 0);
            const isEven   = i % 2 === 0;
            return `
              <tr class="${isEven ? 'bg-white' : 'bg-gray-50'} border-b border-gray-50">
                <td class="px-4 py-3 sticky left-0 z-10 border-r border-gray-100 ${isEven ? 'bg-white' : 'bg-gray-50'}">
                  <span class="font-bold text-gray-800">${dayNum}</span>
                  <span class="text-gray-400 text-xs ml-1">${dayName}</span>
                </td>
                ${operators.map(op => {
                  const qty = byDate[date][op.id] || 0;
                  return `<td class="px-3 py-3 text-center font-semibold ${qty > 0 ? 'text-gray-800' : 'text-gray-200'}">${qty > 0 ? qty.toLocaleString('es-DO') : '—'}</td>`;
                }).join('')}
                <td class="px-3 py-3 text-center font-bold text-blue-600">${rowTotal.toLocaleString('es-DO')}</td>
              </tr>`;
          }).join('')}
        </tbody>
        <tfoot>
          <tr class="border-t-2 border-gray-200 bg-gray-50">
            <td class="px-4 py-3 sticky left-0 bg-gray-50 z-10 border-r border-gray-100">
              <span class="text-xs font-bold text-gray-500 uppercase tracking-wide">Total</span>
            </td>
            ${operators.map(op => `
              <td class="px-3 py-3 text-center font-extrabold text-gray-800">${opTotals[op.id].toLocaleString('es-DO')}</td>
            `).join('')}
            <td class="px-3 py-3 text-center font-extrabold text-blue-600">${grandTotal.toLocaleString('es-DO')}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

// ─── PANEL SUPERVISOR ─────────────────────────────────────────────────────────

async function renderSupervisorPanel(activeTab = 'sales') {
  $('app').innerHTML = `
    <div class="min-h-screen bg-gray-50 flex flex-col">
      <header class="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 sticky top-0 z-10 shadow-sm">
        <button id="back-btn" class="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors">←</button>
        <h1 class="text-base font-bold text-gray-800">Panel Supervisor</h1>
        <span id="connection-badge" class="ml-auto text-xs"></span>
      </header>

      <!-- Tabs -->
      <div class="bg-white border-b border-gray-100 px-4 flex gap-1 overflow-x-auto">
        ${[
          { id: 'sales',     label: 'Ventas' },
          { id: 'pending',   label: `Pendientes${App.pendingCount > 0 ? ` (${App.pendingCount})` : ''}` },
          { id: 'operators', label: 'Operarios' },
          { id: 'prices',    label: 'Precios' },
          { id: 'accounts',  label: 'Cuentas' },
        ].map(t => `
          <button data-tab="${t.id}"
            class="tab-btn py-3 px-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${activeTab === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-400 hover:text-gray-600'}">
            ${t.label}
          </button>
        `).join('')}
      </div>

      <main id="tab-content" class="flex-1 p-4 overflow-y-auto"></main>
    </div>
  `;

  setConnectionBadge();
  $('back-btn').addEventListener('click', renderWindowSelectionMenu);

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => renderSupervisorPanel(btn.dataset.tab));
  });

  const content = $('tab-content');

  if (activeTab === 'sales')     await renderSalesTab(content);
  if (activeTab === 'pending')   await renderPendingTab(content);
  if (activeTab === 'operators') await renderOperatorsTab(content);
  if (activeTab === 'prices')    await renderPricesTab(content);
  if (activeTab === 'accounts')  await renderAccountsTab(content);
}

// Tab: Ventas
async function renderSalesTab(container) {
  container.innerHTML = '<p class="text-gray-400 text-sm text-center py-6">Cargando ventas...</p>';

  const today = getCurrentDate();
  const { data, error } = await supabaseRequest(
    `sales?invoice_number=like.${INVOICE_PREFIX}*&sale_date=eq.${today}&order=created_at.desc&select=id,invoice_number,sale_date,client_id,status,totals,lines,notes`
  );

  if (error || !data) {
    container.innerHTML = '<p class="text-red-400 text-sm text-center py-6">Error al cargar ventas</p>';
    return;
  }

  if (data.length === 0) {
    container.innerHTML = '<p class="text-gray-400 text-sm text-center py-6">No hay ventas de CapDispatch hoy</p>';
    return;
  }

  container.innerHTML = `
    <div class="space-y-3">
      ${data.map(sale => {
        const lines  = Array.isArray(sale.lines) ? sale.lines : [];
        const totals = sale.totals || {};
        const statusColor = sale.status === 'confirmed' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700';
        return `
          <div class="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <div class="flex items-start justify-between mb-2">
              <div>
                <p class="font-semibold text-gray-800 text-sm">${sale.invoice_number}</p>
                <p class="text-xs text-gray-400">${sale.notes || ''}</p>
              </div>
              <div class="flex flex-col items-end gap-1">
                <span class="text-xs px-2 py-0.5 rounded-full font-medium ${statusColor}">${sale.status}</span>
                <p class="font-bold text-blue-600 text-sm">${fmt(totals.revenue || 0)}</p>
              </div>
            </div>
            <p class="text-xs text-gray-400 mb-3">${lines.map(l => `${l.quantity} paq.`).join(', ')}</p>
            <div class="flex gap-2">
              <button data-sale-id="${sale.id}" class="edit-sale-btn flex-1 py-2 text-xs font-medium rounded-lg border border-blue-200 text-blue-600 hover:bg-blue-50 transition-colors">
                Editar
              </button>
              <button data-sale-id="${sale.id}" class="cancel-sale-btn flex-1 py-2 text-xs font-medium rounded-lg border border-red-200 text-red-500 hover:bg-red-50 transition-colors ${sale.status === 'cancelled' ? 'opacity-40 pointer-events-none' : ''}">
                Cancelar
              </button>
            </div>
          </div>`;
      }).join('')}
    </div>
  `;

  document.querySelectorAll('.cancel-sale-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Cancelar esta venta?')) return;
      const { error } = await supabaseRequest(`sales?id=eq.${btn.dataset.saleId}`, {
        method: 'PATCH',
        body:   { status: 'cancelled', updated_at: new Date().toISOString() },
        prefer: 'return=minimal',
      });
      if (error) { showToast('Error al cancelar', 'error'); return; }
      showToast('Venta cancelada', 'success');
      await renderSupervisorPanel('sales');
    });
  });

  document.querySelectorAll('.edit-sale-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sale = data.find(s => s.id === btn.dataset.saleId);
      renderEditSaleModal(sale);
    });
  });
}

// Modal: editar venta
function renderEditSaleModal(sale) {
  const existing = document.querySelector('.cd-modal');
  if (existing) existing.remove();

  const lines = Array.isArray(sale.lines) ? sale.lines : [];
  const overlay = document.createElement('div');
  overlay.className = 'cd-modal fixed inset-0 bg-black/40 z-30 flex items-end justify-center';

  overlay.innerHTML = `
    <div class="bg-white w-full max-w-lg rounded-t-3xl p-5 shadow-xl max-h-[80vh] overflow-y-auto">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-base font-bold text-gray-800">Editar ${sale.invoice_number}</h2>
        <button id="modal-close" class="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-500">✕</button>
      </div>
      <div id="edit-lines" class="space-y-3 mb-4">
        ${lines.map((line, idx) => {
          const prod = App.products.find(p => p.id === line.productId);
          return `
            <div class="border border-gray-100 rounded-xl p-3">
              <p class="text-sm font-medium text-gray-700 mb-2">${prod?.name || line.productId}</p>
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="text-xs text-gray-400">Cantidad</label>
                  <input type="number" data-line="${idx}" data-field="quantity" value="${line.quantity}" min="1"
                    class="edit-field w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400"/>
                </div>
                <div>
                  <label class="text-xs text-gray-400">Precio unitario</label>
                  <input type="number" data-line="${idx}" data-field="unitPrice" value="${line.unitPrice}" min="0"
                    class="edit-field w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-blue-400"/>
                </div>
              </div>
            </div>`;
        }).join('')}
      </div>
      <button id="save-edit-btn"
        class="w-full bg-blue-600 text-white font-semibold py-3 rounded-xl hover:bg-blue-700 transition-colors">
        Guardar cambios
      </button>
    </div>
  `;

  document.body.appendChild(overlay);
  $('modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  $('save-edit-btn').addEventListener('click', async () => {
    const updatedLines = [...lines];
    document.querySelectorAll('.edit-field').forEach(input => {
      const idx   = Number(input.dataset.line);
      const field = input.dataset.field;
      updatedLines[idx][field] = Number(input.value);
    });

    // Recalcular totals
    let rev = 0, cost = 0;
    updatedLines.forEach(l => {
      l.lineRevenue = l.unitPrice * l.quantity;
      l.lineCost    = l.costPerUnitSnapshot * l.quantity;
      l.lineProfit  = l.lineRevenue - l.lineCost;
      rev  += l.lineRevenue;
      cost += l.lineCost;
    });

    const existingTotals = sale.totals || {};
    const invDisc  = (existingTotals.investor?.benefitDiscountTotal || 0);
    const invAmort = (existingTotals.investor?.amortizationTotal    || 0);
    const actualRev = rev - invDisc - invAmort;
    const profit    = actualRev - cost;

    const newTotals = {
      revenue: actualRev,
      cost,
      profit,
      margin: actualRev > 0 ? profit / actualRev : 0,
      investor: existingTotals.investor || { benefitDiscountTotal: 0, amortizationTotal: 0 },
    };

    const { error } = await supabaseRequest(`sales?id=eq.${sale.id}`, {
      method: 'PATCH',
      body:   { lines: updatedLines, totals: newTotals, updated_at: new Date().toISOString() },
      prefer: 'return=minimal',
    });

    if (error) { showToast('Error al guardar', 'error'); return; }
    showToast('Venta actualizada', 'success');
    overlay.remove();
    await renderSupervisorPanel('sales');
  });
}

// Tab: Pendientes
async function renderPendingTab(container) {
  const pending = await pendingSaleGetAll();

  if (pending.length === 0) {
    container.innerHTML = `
      <div class="text-center py-10">
        <p class="text-3xl mb-3">✓</p>
        <p class="text-gray-500 font-medium">Sin ventas pendientes</p>
        <p class="text-gray-400 text-sm">Todo está sincronizado</p>
      </div>`;
    return;
  }

  container.innerHTML = `
    <button id="retry-all-btn"
      class="w-full mb-4 bg-blue-600 text-white font-semibold py-3 rounded-xl hover:bg-blue-700 transition-colors text-sm">
      Reintentar sincronización (${pending.length})
    </button>
    <div class="space-y-3">
      ${pending.map(sale => {
        const statusColor = sale.sync_status === 'failed' ? 'bg-red-100 text-red-600' : 'bg-yellow-100 text-yellow-700';
        const statusLabel = sale.sync_status === 'failed' ? 'Falló' : 'Pendiente';
        return `
          <div class="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <div class="flex items-start justify-between mb-1">
              <p class="text-sm font-medium text-gray-800">${sale.operator_name}</p>
              <span class="text-xs px-2 py-0.5 rounded-full font-medium ${statusColor}">${statusLabel}</span>
            </div>
            <p class="text-xs text-gray-400 mb-1">${sale.sale_date} · ${App.paymentMethod === 'cash' ? 'Efectivo' : 'Transferencia'}</p>
            <p class="font-bold text-blue-600 text-sm">${fmt(sale.totals?.revenue || 0)}</p>
            ${sale.sync_error ? `<p class="text-xs text-red-400 mt-1">${sale.sync_error}</p>` : ''}
          </div>`;
      }).join('')}
    </div>
  `;

  $('retry-all-btn').addEventListener('click', async () => {
    if (!navigator.onLine) { showToast('Sin conexión', 'warning'); return; }
    $('retry-all-btn').textContent = 'Sincronizando...';
    $('retry-all-btn').disabled = true;
    const result = await syncRetryAll();
    App.pendingCount = await pendingSaleCount();
    showToast(`${result?.synced || 0} sincronizadas, ${result?.failed || 0} fallidas`, result?.failed > 0 ? 'warning' : 'success');
    await renderSupervisorPanel('pending');
  });
}

// Tab: Operarios
async function renderOperatorsTab(container) {
  const operators = await listOperators();

  container.innerHTML = `
    <button id="add-op-btn"
      class="w-full mb-4 border-2 border-dashed border-blue-300 text-blue-500 font-semibold py-3 rounded-xl hover:bg-blue-50 transition-colors text-sm">
      + Agregar operario
    </button>
    <div class="space-y-2">
      ${operators.map(op => `
        <div class="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-3 flex items-center justify-between">
          <div>
            <p class="text-sm font-medium text-gray-800">${op.name}</p>
            <p class="text-xs text-gray-400">${op.role === 'supervisor' ? 'Supervisor' : 'Operario'}</p>
          </div>
          ${op.id !== App.user?.id ? `
            <button data-op-id="${op.id}" class="deactivate-btn text-xs text-red-400 hover:text-red-500 font-medium px-2 py-1 rounded-lg hover:bg-red-50 transition-colors">
              Desactivar
            </button>` : '<span class="text-xs text-gray-300">Tú</span>'}
        </div>`).join('')}
    </div>
  `;

  $('add-op-btn').addEventListener('click', () => renderAddOperatorModal());

  document.querySelectorAll('.deactivate-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Desactivar este operario?')) return;
      const result = await deactivateOperator(btn.dataset.opId);
      if (result.success) { showToast('Operario desactivado', 'success'); await renderSupervisorPanel('operators'); }
      else showToast(result.error, 'error');
    });
  });
}

function renderAddOperatorModal() {
  const existing = document.querySelector('.cd-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'cd-modal fixed inset-0 bg-black/40 z-30 flex items-end justify-center';

  overlay.innerHTML = `
    <div class="bg-white w-full max-w-lg rounded-t-3xl p-5 shadow-xl">
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-base font-bold text-gray-800">Nuevo operario</h2>
        <button id="modal-close" class="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-500">✕</button>
      </div>
      <div class="space-y-3 mb-4">
        <div>
          <label class="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1 block">Nombre</label>
          <input id="op-name" type="text" placeholder="Nombre completo"
            class="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1 block">PIN</label>
          <input id="op-pin" type="password" placeholder="Mínimo 4 dígitos"
            class="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1 block">Rol</label>
          <select id="op-role" class="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400">
            <option value="operator">Operario</option>
            <option value="supervisor">Supervisor</option>
          </select>
        </div>
      </div>
      <button id="save-op-btn"
        class="w-full bg-blue-600 text-white font-semibold py-3 rounded-xl hover:bg-blue-700 transition-colors">
        Crear operario
      </button>
    </div>
  `;

  document.body.appendChild(overlay);
  $('modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  $('save-op-btn').addEventListener('click', async () => {
    const name = $('op-name').value.trim();
    const pin  = $('op-pin').value.trim();
    const role = $('op-role').value;

    if (!name || !pin) { showToast('Completa todos los campos', 'warning'); return; }

    $('save-op-btn').textContent = 'Guardando...';
    $('save-op-btn').disabled = true;

    const result = await createOperator({ name, pin, role });
    if (result.success) {
      showToast('Operario creado', 'success');
      overlay.remove();
      await renderSupervisorPanel('operators');
    } else {
      showToast(result.error, 'error');
      $('save-op-btn').textContent = 'Crear operario';
      $('save-op-btn').disabled = false;
    }
  });
}

// Tab: Precios
async function renderPricesTab(container) {
  const products = App.products;

  container.innerHTML = `
    <p class="text-xs text-gray-400 mb-3">Los cambios se aplican a nuevas ventas inmediatamente.</p>
    <div class="space-y-2" id="prices-list">
      ${products.map(p => {
        const price = App.prices[p.id] || DEFAULT_PRODUCT_PRICE;
        return `
          <div class="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-3 flex items-center gap-3">
            <p class="flex-1 text-sm font-medium text-gray-800">${p.name}</p>
            <div class="flex items-center gap-1">
              <span class="text-gray-400 text-sm">RD$</span>
              <input type="number" data-product-id="${p.id}" value="${price}" min="0"
                class="price-input w-24 border border-gray-200 rounded-lg px-2 py-1.5 text-sm font-bold text-gray-800 text-right focus:outline-none focus:border-blue-400"/>
            </div>
            <button data-product-id="${p.id}" class="save-price-btn text-xs bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors font-medium">
              Guardar
            </button>
          </div>`;
      }).join('')}
    </div>
  `;

  document.querySelectorAll('.save-price-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const productId = btn.dataset.productId;
      const input     = document.querySelector(`.price-input[data-product-id="${productId}"]`);
      const newPrice  = Number(input.value);

      if (!newPrice || newPrice < 0) { showToast('Precio inválido', 'warning'); return; }

      btn.textContent = '...';
      btn.disabled = true;

      const { error } = await supabaseRequest(
        `dispatch_product_prices?product_id=eq.${productId}`,
        {
          method: 'PATCH',
          body:   { default_price: newPrice, updated_at: new Date().toISOString(), updated_by: App.user.id },
          prefer: 'return=minimal',
        }
      );

      if (error) { showToast('Error al guardar precio', 'error'); }
      else {
        App.prices[productId] = newPrice;
        await cacheSet('prices', App.prices);
        showToast('Precio actualizado', 'success');
      }

      btn.textContent = 'Guardar';
      btn.disabled = false;
    });
  });
}

// Tab: Cuentas de transferencia
async function renderAccountsTab(container) {
  const { data, error } = await supabaseRequest(
    'dispatch_transfer_accounts?select=id,bank_name,account_number,account_holder,id_number,is_active&order=created_at.asc'
  );
  const accounts = (!error && data) ? data : App.transferAccounts;

  container.innerHTML = `
    <button id="add-account-btn"
      class="w-full mb-4 border-2 border-dashed border-blue-300 text-blue-500 font-semibold py-3 rounded-xl hover:bg-blue-50 transition-colors text-sm">
      + Agregar cuenta
    </button>
    <div class="space-y-3">
      ${accounts.map(acc => `
        <div class="bg-white rounded-xl border border-gray-100 shadow-sm p-4 ${!acc.is_active ? 'opacity-50' : ''}">
          <div class="flex items-start justify-between mb-2">
            <p class="font-extrabold text-gray-800">${acc.bank_name}</p>
            <span class="text-xs px-2 py-0.5 rounded-full font-medium ${acc.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}">
              ${acc.is_active ? 'Activa' : 'Inactiva'}
            </span>
          </div>
          <p class="text-sm text-gray-600 mb-0.5">No. <span class="font-bold text-gray-800">${acc.account_number}</span></p>
          <p class="text-sm text-gray-600 mb-0.5">${acc.account_holder}</p>
          <p class="text-sm text-gray-400 mb-3">Cédula: ${acc.id_number}</p>
          <div class="flex gap-2">
            <button data-id="${acc.id}" class="edit-account-btn flex-1 py-2 text-xs font-medium rounded-lg border border-blue-200 text-blue-600 hover:bg-blue-50 transition-colors">
              Editar
            </button>
            <button data-id="${acc.id}" data-active="${acc.is_active}" class="toggle-account-btn flex-1 py-2 text-xs font-medium rounded-lg border transition-colors ${acc.is_active ? 'border-red-200 text-red-500 hover:bg-red-50' : 'border-green-200 text-green-600 hover:bg-green-50'}">
              ${acc.is_active ? 'Desactivar' : 'Activar'}
            </button>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  $('add-account-btn').addEventListener('click', () => renderAccountModal());

  document.querySelectorAll('.edit-account-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const acc = accounts.find(a => a.id === btn.dataset.id);
      if (acc) renderAccountModal(acc);
    });
  });

  document.querySelectorAll('.toggle-account-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const isActive = btn.dataset.active === 'true';
      const { error } = await supabaseRequest(
        `dispatch_transfer_accounts?id=eq.${btn.dataset.id}`,
        { method: 'PATCH', body: { is_active: !isActive, updated_at: new Date().toISOString() }, prefer: 'return=minimal' }
      );
      if (error) { showToast('Error al actualizar', 'error'); return; }
      await loadAppData();
      showToast(isActive ? 'Cuenta desactivada' : 'Cuenta activada', 'success');
      await renderSupervisorPanel('accounts');
    });
  });
}

function renderAccountModal(acc = null) {
  const existing = document.querySelector('.cd-modal');
  if (existing) existing.remove();

  const isEdit = !!acc;
  const overlay = document.createElement('div');
  overlay.className = 'cd-modal fixed inset-0 bg-black/40 z-30 flex items-end justify-center';

  overlay.innerHTML = `
    <div class="bg-white w-full max-w-lg rounded-t-3xl p-5 shadow-xl">
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-base font-bold text-gray-800">${isEdit ? 'Editar cuenta' : 'Nueva cuenta'}</h2>
        <button id="modal-close" class="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-500">✕</button>
      </div>
      <div class="space-y-3 mb-4">
        <div>
          <label class="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1 block">Banco</label>
          <input id="acc-bank" type="text" value="${acc?.bank_name || ''}" placeholder="Ej: BHD, Banreservas..."
            class="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1 block">Número de cuenta</label>
          <input id="acc-number" type="text" value="${acc?.account_number || ''}" placeholder="Ej: 31830050015"
            class="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1 block">Nombre del titular</label>
          <input id="acc-holder" type="text" value="${acc?.account_holder || ''}" placeholder="Nombre completo"
            class="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 uppercase font-semibold tracking-wide mb-1 block">Cédula</label>
          <input id="acc-id" type="text" value="${acc?.id_number || ''}" placeholder="Ej: 402-3294903-8"
            class="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-blue-400"/>
        </div>
      </div>
      <button id="save-account-btn"
        class="w-full bg-blue-600 text-white font-semibold py-3 rounded-xl hover:bg-blue-700 transition-colors">
        ${isEdit ? 'Guardar cambios' : 'Agregar cuenta'}
      </button>
    </div>
  `;

  document.body.appendChild(overlay);
  $('modal-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  $('save-account-btn').addEventListener('click', async () => {
    const bank   = $('acc-bank').value.trim();
    const number = $('acc-number').value.trim();
    const holder = $('acc-holder').value.trim();
    const idNum  = $('acc-id').value.trim();

    if (!bank || !number || !holder || !idNum) {
      showToast('Completa todos los campos', 'warning'); return;
    }

    $('save-account-btn').textContent = 'Guardando...';
    $('save-account-btn').disabled = true;

    let error;
    if (isEdit) {
      ({ error } = await supabaseRequest(
        `dispatch_transfer_accounts?id=eq.${acc.id}`,
        { method: 'PATCH', body: { bank_name: bank, account_number: number, account_holder: holder, id_number: idNum, updated_at: new Date().toISOString() }, prefer: 'return=minimal' }
      ));
    } else {
      ({ error } = await supabaseRequest(
        'dispatch_transfer_accounts',
        { method: 'POST', body: { id: generateId('transfer'), bank_name: bank, account_number: number, account_holder: holder, id_number: idNum, is_active: true }, prefer: 'return=minimal' }
      ));
    }

    if (error) { showToast('Error al guardar', 'error'); return; }
    await loadAppData();
    showToast(isEdit ? 'Cuenta actualizada' : 'Cuenta agregada', 'success');
    overlay.remove();
    await renderSupervisorPanel('accounts');
  });
}

// ─── PANTALLA: ENTRADA DE MATERIA PRIMA ──────────────────────────────────────

const MATERIAL_TYPES = [
  { value: 'recycled',       label: 'Reciclado'     },
  { value: 'pellet',         label: 'Pellet Virgen'  },
  { value: 'pellet_regular', label: 'Pellet'         },
  { value: 'colorant',       label: 'Colorante'      },
];

function renderMaterialEntryScreen() {
  $('app').innerHTML = `
    <div class="min-h-screen bg-gray-50 flex flex-col">

      <!-- Header -->
      <header class="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 sticky top-0 z-10 shadow-sm">
        <button id="mat-back-btn" class="p-2 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
          </svg>
        </button>
        <div>
          <h1 class="text-base font-bold text-gray-800">Entrada de Materia Prima</h1>
          <p class="text-xs text-gray-400">Registra el material recibido</p>
        </div>
      </header>

      <main class="flex-1 p-4">
        <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">

          <form id="mat-entry-form" novalidate class="space-y-4">

            <!-- Tipo de material -->
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1">
                Tipo de material <span class="text-red-500">*</span>
              </label>
              <div class="grid grid-cols-2 gap-2">
                ${MATERIAL_TYPES.map(t => `
                  <label class="mat-type-option flex items-center gap-2 border-2 border-gray-200 rounded-xl p-3 cursor-pointer transition-all hover:border-orange-300 has-[:checked]:border-orange-500 has-[:checked]:bg-orange-50">
                    <input type="radio" name="mat-type" value="${t.value}" class="sr-only" required>
                    <div class="mat-type-dot w-3 h-3 rounded-full border-2 border-gray-300 flex-shrink-0"></div>
                    <span class="text-sm font-semibold text-gray-700">${t.label}</span>
                  </label>
                `).join('')}
              </div>
              <p id="mat-error-type" class="text-red-500 text-xs mt-1 hidden">Selecciona el tipo de material.</p>
            </div>

            <!-- Fecha -->
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1" for="mat-date">
                Fecha <span class="text-red-500">*</span>
              </label>
              <input
                id="mat-date"
                type="date"
                class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:border-orange-400 focus:outline-none transition-colors"
                value="${getCurrentDate()}"
                required
              >
              <p id="mat-error-date" class="text-red-500 text-xs mt-1 hidden">La fecha es obligatoria.</p>
            </div>

            <!-- Peso -->
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1" for="mat-weight">
                Peso (lbs) <span class="text-red-500">*</span>
              </label>
              <input
                id="mat-weight"
                type="number"
                inputmode="decimal"
                class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:border-orange-400 focus:outline-none transition-colors"
                placeholder="0.00"
                min="0.01"
                step="0.01"
                required
              >
              <p id="mat-error-weight" class="text-red-500 text-xs mt-1 hidden">El peso debe ser mayor a 0.</p>
            </div>

            <!-- Proveedor (opcional) -->
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1" for="mat-provider">
                Proveedor <span class="text-gray-400 font-normal">(opcional)</span>
              </label>
              <input
                id="mat-provider"
                type="text"
                class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:border-orange-400 focus:outline-none transition-colors"
                placeholder="Nombre del proveedor"
              >
            </div>

            <!-- Notas (opcional) -->
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1" for="mat-notes">
                Notas <span class="text-gray-400 font-normal">(opcional)</span>
              </label>
              <textarea
                id="mat-notes"
                class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:border-orange-400 focus:outline-none transition-colors resize-none"
                rows="2"
                placeholder="Ej: Llegó en 3 sacos, se verificó el peso en báscula..."
              ></textarea>
            </div>

            <button
              type="submit"
              id="mat-submit-btn"
              class="w-full bg-orange-500 hover:bg-orange-600 active:bg-orange-700 text-white font-bold py-4 rounded-xl transition-colors text-base shadow-sm"
            >
              Registrar entrada
            </button>

          </form>

        </div>
      </main>

    </div>
  `;

  $('mat-back-btn').addEventListener('click', () => renderWindowSelectionMenu());

  // Radio button visual update
  document.querySelectorAll('input[name="mat-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      document.querySelectorAll('.mat-type-option').forEach(lbl => {
        const dot = lbl.querySelector('.mat-type-dot');
        const inp = lbl.querySelector('input[type="radio"]');
        if (inp.checked) {
          dot.className = 'mat-type-dot w-3 h-3 rounded-full border-2 border-orange-500 bg-orange-500 flex-shrink-0';
        } else {
          dot.className = 'mat-type-dot w-3 h-3 rounded-full border-2 border-gray-300 flex-shrink-0';
        }
      });
    });
  });

  $('mat-entry-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    // Validate
    let valid = true;
    const typeInput = document.querySelector('input[name="mat-type"]:checked');
    const date      = $('mat-date').value;
    const weight    = parseFloat($('mat-weight').value);
    const notes     = $('mat-notes').value.trim();
    const provider  = $('mat-provider').value.trim();

    const showErr = (id) => { const el = $(id); if (el) { el.classList.remove('hidden'); } };
    const hideErr = (id) => { const el = $(id); if (el) { el.classList.add('hidden'); } };

    hideErr('mat-error-type');
    hideErr('mat-error-date');
    hideErr('mat-error-weight');

    if (!typeInput) { showErr('mat-error-type');   valid = false; }
    if (!date)      { showErr('mat-error-date');   valid = false; }
    if (!weight || weight <= 0) { showErr('mat-error-weight'); valid = false; }

    if (!valid) return;

    const btn = $('mat-submit-btn');
    btn.textContent = 'Guardando...';
    btn.disabled = true;

    try {
      await saveMaterialEntry({
        type:          typeInput.value,
        receipt_date:  date,
        month:         date.slice(0, 7),
        weight_lbs:    weight,
        notes,
        provider,
        operator_name: App.user?.name || '',
      });

      showToast('Entrada registrada', 'success');
      renderWindowSelectionMenu();
    } catch (err) {
      showToast('Error al guardar la entrada', 'error');
      btn.textContent = 'Registrar entrada';
      btn.disabled = false;
    }
  });
}

async function saveMaterialEntry(data) {
  const entry = {
    id:            generateId('mat'),
    type:          data.type,
    receipt_date:  data.receipt_date,
    month:         data.month,
    weight_lbs:    data.weight_lbs,
    notes:         data.notes || '',
    provider:      data.provider || '',
    operator_name: data.operator_name || '',
    status:        'pending',
    created_at:    new Date().toISOString(),
    sync_status:   'pending',
  };

  // Save locally first
  await pendingMaterialEntryAdd(entry);

  // Sync immediately if online
  if (navigator.onLine) {
    await syncMaterialEntries();
  }
}


// ─── PANTALLA: PESO DE PAQUETE DE TAPAS ──────────────────────────────────────

function renderPackageWeightScreen() {
  $('app').innerHTML = `
    <div class="min-h-screen bg-gray-50 flex flex-col">

      <!-- Header -->
      <header class="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 sticky top-0 z-10 shadow-sm">
        <button id="pw-back-btn" class="p-2 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
          </svg>
        </button>
        <div>
          <h1 class="text-base font-bold text-gray-800">Peso de Paquete de Tapas</h1>
          <p class="text-xs text-gray-400">Registra el peso de 1,000 tapas de tu turno</p>
        </div>
      </header>

      <main class="flex-1 p-4">
        <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">

          <!-- Contexto informativo -->
          <div class="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 mb-5">
            <p class="text-blue-700 text-sm font-semibold mb-1">¿Cómo hacerlo?</p>
            <p class="text-blue-600 text-xs leading-relaxed">Cuenta exactamente 1,000 tapas, pésalas en la báscula y anota el resultado aquí. Este peso se usa como referencia para todos los paquetes del turno.</p>
          </div>

          <form id="pw-form" novalidate class="space-y-4">

            <!-- Fecha del turno (sólo lectura) -->
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1">
                Fecha del turno
              </label>
              <div class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm bg-gray-50 text-gray-600">
                ${new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })}
              </div>
            </div>

            <!-- Peso en libras -->
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1" for="pw-weight">
                Peso de 1,000 tapas (lb) <span class="text-red-500">*</span>
              </label>
              <input
                id="pw-weight"
                type="number"
                inputmode="decimal"
                class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:border-blue-400 focus:outline-none transition-colors"
                placeholder="0.00"
                min="0.01"
                step="0.01"
                required
              >
              <p id="pw-error-weight" class="text-red-500 text-xs mt-1 hidden">El peso debe ser mayor a 0.</p>
            </div>

            <!-- Notas (opcional) -->
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-1" for="pw-notes">
                Notas <span class="text-gray-400 font-normal">(opcional)</span>
              </label>
              <textarea
                id="pw-notes"
                class="w-full border-2 border-gray-200 rounded-xl px-4 py-3 text-sm focus:border-blue-400 focus:outline-none transition-colors resize-none"
                rows="2"
                placeholder="Ej: Turno matutino, báscula calibrada..."
              ></textarea>
            </div>

            <button
              type="submit"
              id="pw-submit-btn"
              class="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold py-4 rounded-xl transition-colors text-base shadow-sm"
            >
              Registrar peso
            </button>

          </form>

        </div>
      </main>

    </div>
  `;

  $('pw-back-btn').addEventListener('click', () => renderWindowSelectionMenu());

  $('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const date   = getCurrentDate();
    const weight = parseFloat($('pw-weight').value);
    const notes  = $('pw-notes').value.trim();

    const showErr = (id) => { const el = $(id); if (el) el.classList.remove('hidden'); };
    const hideErr = (id) => { const el = $(id); if (el) el.classList.add('hidden'); };

    hideErr('pw-error-weight');

    let valid = true;
    if (!weight || weight <= 0) { showErr('pw-error-weight'); valid = false; }

    if (!valid) return;

    const btn = $('pw-submit-btn');
    btn.textContent = 'Guardando...';
    btn.disabled = true;

    try {
      await savePackageWeight({ shift_date: date, weight_lbs: weight, notes });
      showToast('Peso registrado', 'success');
      renderWindowSelectionMenu();
    } catch (err) {
      showToast('Error al guardar el peso', 'error');
      btn.textContent = 'Registrar peso';
      btn.disabled = false;
    }
  });
}

async function savePackageWeight(data) {
  const entry = {
    id:            generateId('pw'),
    weight_lbs:    data.weight_lbs,
    operator_name: App.user?.name || '',
    shift_date:    data.shift_date,
    notes:         data.notes || '',
    created_at:    new Date().toISOString(),
    sync_status:   'pending',
  };

  await pendingPackageWeightAdd(entry);

  if (navigator.onLine) {
    await syncPackageWeights();
  }
}


// ─── INICIALIZACIÓN ───────────────────────────────────────────────────────────

async function initApp() {
  // Registrar el service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('Service worker no registrado:', err);
    });
  }

  // Abrir IndexedDB
  await idbOpen();

  // Intentar sincronizar al arrancar si hay pendientes e internet
  if (navigator.onLine) {
    syncPendingSales();
    syncMaterialEntries();
  }

  // Si hay sesión activa, ir al menú de ventanas
  if (isLoggedIn()) {
    App.user = getCurrentUser();
    await loadAppData();
    renderWindowSelectionMenu();
  } else {
    renderPinScreen();
  }

  window.addEventListener('online',  setConnectionBadge);
  window.addEventListener('offline', setConnectionBadge);

  // Resetear timer de inactividad con cualquier interacción del usuario
  ['touchstart', 'click', 'keydown', 'mousemove'].forEach(evt => {
    document.addEventListener(evt, resetInactivityTimer, { passive: true });
  });
}


// ─── PANTALLA: REGISTRO DIARIO DE TAPAS ──────────────────────────────────────


let _selectedColor = null;

function getCurrentDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function renderDailyProductionScreen() {
  _selectedColor = null;
  const today = getCurrentDate();

  $('app').innerHTML = `
    <div class="min-h-screen bg-gray-50 flex flex-col">
      <header class="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 sticky top-0 z-10 shadow-sm">
        <button id="back-btn" class="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors flex-shrink-0">←</button>
        <div>
          <h1 class="text-base font-bold text-gray-800">Registrar tapas del día</h1>
          <p class="text-xs text-gray-400">${App.user?.name || ''}</p>
        </div>
      </header>

      <main class="flex-1 p-4 space-y-4">

        <!-- Fecha -->
        <div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Fecha</label>
          <input id="prod-date" type="date" value="${today}"
            class="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-purple-300"/>
        </div>

        <!-- Selector de producto -->
        <div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Producto</label>
          <div class="grid grid-cols-3 gap-2" id="color-grid">
            ${App.products.length === 0
              ? `<p class="col-span-3 text-gray-400 text-sm text-center py-2">Sin productos disponibles</p>`
              : App.products.map(p => {
                  return `<button data-color="${p.name}"
                    class="color-chip flex items-center gap-2 px-3 py-2 rounded-xl border-2 border-gray-200 text-sm font-semibold transition-all bg-gray-50 text-gray-800 hover:bg-gray-100">
                    ${p.name}
                  </button>`;
                }).join('')}
          </div>
        </div>

        <!-- Cantidad -->
        <div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Cantidad de tapas</label>
          <input id="prod-qty" type="number" min="1" placeholder="Ej: 5000"
            class="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-purple-300"/>
        </div>

        <!-- Notas (opcional) -->
        <div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
          <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Notas <span class="text-gray-300 font-normal">(opcional)</span></label>
          <textarea id="prod-notes" rows="2" placeholder="Observaciones del turno..."
            class="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-purple-300 resize-none"></textarea>
        </div>

        <!-- Botón guardar -->
        <button id="prod-submit"
          class="w-full bg-purple-600 text-white font-bold py-4 rounded-2xl hover:bg-purple-700 active:scale-95 transition-all shadow-md">
          Guardar registro
        </button>

        <!-- Registros de hoy -->
        <div>
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Mis registros del día</p>
          <div id="today-entries">
            <p class="text-gray-400 text-sm text-center py-4">Cargando...</p>
          </div>
        </div>

      </main>
    </div>
  `;

  $('back-btn').addEventListener('click', renderWindowSelectionMenu);

  // Selección de color
  document.querySelectorAll('.color-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.color-chip').forEach(b => b.style.outline = 'none');
      _selectedColor = btn.dataset.color;
      btn.style.outline = '3px solid #7c3aed';
      btn.style.outlineOffset = '2px';
    });
  });

  $('prod-submit').addEventListener('click', handleDailyProductionSubmit);

  await loadTodayEntries(today);
}

async function handleDailyProductionSubmit() {
  const date  = $('prod-date').value;
  const qty   = parseInt($('prod-qty').value, 10);
  const notes = ($('prod-notes').value || '').trim();

  if (!_selectedColor) {
    alert('Selecciona un color antes de guardar.');
    return;
  }
  if (!qty || qty < 1) {
    alert('Ingresa una cantidad válida (mínimo 1).');
    return;
  }
  if (!date) {
    alert('Selecciona una fecha.');
    return;
  }

  const btn = $('prod-submit');
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  const entry = {
    id:              generateId('dpl'),
    operator_id:     App.user.id,
    operator_name:   App.user.name,
    production_date: date,
    month:           date.slice(0, 7),
    color:           _selectedColor,
    quantity:        qty,
    notes:           notes,
    status:          'pending_review',
    created_at:      new Date().toISOString(),
    sync_status:     'pending',
  };

  try {
    await pendingDailyProductionAdd(entry);

    if (navigator.onLine) {
      await syncDailyProduction();
      showToast('Registro guardado ✓', 'success');
    } else {
      showToast('Sin conexión — se enviará al reconectar', 'warning');
    }

    // Limpiar formulario
    _selectedColor = null;
    document.querySelectorAll('.color-chip').forEach(b => b.style.outline = 'none');
    $('prod-qty').value = '';
    $('prod-notes').value = '';

    await loadTodayEntries($('prod-date').value);
  } catch (err) {
    console.error('Error guardando registro de tapas:', err);
    showToast('Error al guardar — intenta de nuevo', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar registro';
  }
}

async function loadTodayEntries(date) {
  const container = $('today-entries');
  if (!container) return;

  try {
    const { data, error } = await supabaseRequest(
      `daily_production_logs?operator_id=eq.${App.user.id}&production_date=eq.${date}&order=created_at.desc`
    );

    if (error || !data || data.length === 0) {
      container.innerHTML = `<p class="text-gray-400 text-sm text-center py-4">Sin registros para esta fecha</p>`;
      return;
    }

    const colorMap = Object.fromEntries(
      App.products.map(p => [p.name, { label: p.name, bg: '#e5e7eb', text: '#374151' }])
    );

    container.innerHTML = data.map(entry => {
      const c = colorMap[entry.color] || { label: entry.color, bg: '#e5e7eb', text: '#374151' };
      const statusBadge = entry.status === 'confirmed'
        ? `<span class="text-xs font-semibold text-green-600 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">Confirmado</span>`
        : `<span class="text-xs font-semibold text-yellow-600 bg-yellow-50 border border-yellow-200 rounded-full px-2 py-0.5">Pendiente</span>`;
      return `
        <div class="bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-3 flex items-center gap-3">
          <span class="w-4 h-4 rounded-full flex-shrink-0 border" style="background:${c.bg}; border-color:${c.border || c.bg};"></span>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-bold text-gray-800">${c.label} — ${entry.quantity.toLocaleString('es-DO')} tapas</p>
            ${entry.notes ? `<p class="text-xs text-gray-400 truncate">${entry.notes}</p>` : ''}
          </div>
          ${statusBadge}
        </div>`;
    }).join('');
  } catch (err) {
    container.innerHTML = `<p class="text-gray-400 text-sm text-center py-4">Sin registros para esta fecha</p>`;
  }
}

// Arrancar cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', initApp);
