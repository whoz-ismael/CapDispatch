// ─── SYNC.JS ──────────────────────────────────────────────────────────────────
// Sincroniza las ventas pendientes (guardadas offline en IndexedDB) con Supabase.
//
// Flujo:
//   1. Al arrancar la app  → intenta sincronizar si hay pendientes
//   2. Al volver el internet → sincroniza automáticamente
//   3. El supervisor puede forzar la sincronización manualmente
//
// Por cada venta pendiente:
//   a. Genera número de factura DISP-XXX
//   b. Inserta en `sales`
//   c. Inserta en `sale_payments`
//   d. Si el cliente es el inversionista → actualiza tabla `investor`
//   e. Elimina la venta del store local

// ─── ESTADO ───────────────────────────────────────────────────────────────────
let _isSyncing    = false;   // Evita sincronizaciones concurrentes
let _onSyncUpdate = null;    // Callback que llama app.js cuando cambia el estado

// Registra un callback para que app.js pueda actualizar la UI
function onSyncUpdate(callback) {
  _onSyncUpdate = callback;
}

function _notifyUpdate() {
  if (typeof _onSyncUpdate === 'function') _onSyncUpdate();
}

// ─── NÚMERO DE FACTURA ────────────────────────────────────────────────────────

// Lee el último número DISP- usado en Supabase y devuelve el siguiente.
// Si no hay ninguno, empieza desde DISP-001.
async function _nextInvoiceNumber() {
  const { data, error } = await supabaseRequest(
    `sales?invoice_number=like.${INVOICE_PREFIX}*&select=invoice_number&order=created_at.desc&limit=1`
  );

  if (error || !data || data.length === 0) {
    return `${INVOICE_PREFIX}001`;
  }

  const last   = data[0].invoice_number; // ej: "DISP-007"
  const num    = parseInt(last.replace(INVOICE_PREFIX, ''), 10);
  const next   = String(num + 1).padStart(3, '0');
  return `${INVOICE_PREFIX}${next}`;
}

// ─── INSERTAR VENTA EN SUPABASE ───────────────────────────────────────────────

async function _insertSale(sale, invoiceNumber) {
  const saleRecord = {
    id:             sale.id,
    sale_date:      sale.sale_date,
    month:          sale.month,
    client_id:      sale.client_id,
    status:         'confirmed',
    notes:          sale.notes || `Despachado por ${sale.operator_name}`,
    invoice_number: invoiceNumber,
    has_ncf:        false,
    ncf_number:     '',
    itbis_rate:     0,
    itbis_amount:   0,
    totals:         sale.totals,
    lines:          sale.lines,
    attachments:    [],
    created_at:     new Date(sale.created_at).toISOString(),
    updated_at:     new Date().toISOString()
  };

  return await supabaseRequest('sales', {
    method:  'POST',
    body:    saleRecord,
    prefer:  'return=minimal'
  });
}

// ─── INSERTAR PAGO EN SUPABASE ────────────────────────────────────────────────

async function _insertPayment(sale) {
  const payment = {
    id:           crypto.randomUUID(),
    sale_id:      sale.id,
    payment_date: sale.sale_date,
    amount:       sale.totals.revenue,
    method:       sale.payment_method,   // 'cash' | 'transfer'
    notes:        '',
    created_at:   new Date().toISOString()
  };

  return await supabaseRequest('sale_payments', {
    method: 'POST',
    body:   payment,
    prefer: 'return=minimal'
  });
}

// ─── ACTUALIZAR INVERSIONISTA ─────────────────────────────────────────────────
// Si la venta es del inversionista, registra la amortización en la tabla investor.

async function _updateInvestor(sale) {
  if (!sale.is_investor || !sale.investor_id) return { error: null };

  // Leer el registro actual del inversionista
  const { data, error: fetchError } = await supabaseRequest(
    `investor?id=eq.${sale.investor_id}&select=id,total_debt,history`
  );

  if (fetchError || !data || data.length === 0) {
    return { error: fetchError || { message: 'Inversionista no encontrado' } };
  }

  const investor        = data[0];
  const amortization    = sale.totals.investor?.amortizationTotal || 0;
  const newDebt         = Math.max(0, (investor.total_debt || 0) - amortization);
  const existingHistory = Array.isArray(investor.history) ? investor.history : [];

  const newHistoryEntry = {
    type:        'amortization',
    amount:      amortization,
    referenceId: sale.id,
    date:        sale.sale_date,
    note:        `Despacho ${sale.invoice_number || ''}`
  };

  return await supabaseRequest(`investor?id=eq.${sale.investor_id}`, {
    method: 'PATCH',
    body: {
      total_debt:  newDebt,
      history:     [...existingHistory, newHistoryEntry],
      updated_at:  Date.now()
    },
    prefer: 'return=minimal'
  });
}

// ─── SINCRONIZAR UNA VENTA ────────────────────────────────────────────────────

async function _syncOne(sale) {
  try {
    // 1. Generar número de factura
    const invoiceNumber = await _nextInvoiceNumber();
    sale.invoice_number = invoiceNumber;

    // 2. Insertar venta
    const { error: saleError } = await _insertSale(sale, invoiceNumber);
    if (saleError) throw new Error(`Error insertando venta: ${JSON.stringify(saleError)}`);

    // 3. Insertar pago
    const { error: payError } = await _insertPayment(sale);
    if (payError) throw new Error(`Error insertando pago: ${JSON.stringify(payError)}`);

    // 4. Actualizar inversionista si aplica
    if (sale.is_investor) {
      const { error: invError } = await _updateInvestor(sale);
      if (invError) throw new Error(`Error actualizando inversionista: ${JSON.stringify(invError)}`);
    }

    // 5. Eliminar del store local
    await pendingSaleRemove(sale.id);
    return { success: true };

  } catch (err) {
    console.error(`_syncOne: falló venta ${sale.id}:`, err.message);
    await pendingSaleMarkFailed(sale.id, err.message);
    return { success: false, error: err.message };
  }
}

// ─── SINCRONIZAR TODAS LAS PENDIENTES ────────────────────────────────────────

async function syncPendingSales() {
  if (_isSyncing) return;
  if (!navigator.onLine) return;

  const pending = await pendingSaleGetAll();
  if (pending.length === 0) return;

  _isSyncing = true;
  _notifyUpdate();

  let synced = 0;
  let failed = 0;

  for (const sale of pending) {
    // Solo intenta las que están en estado 'pending', no las 'failed' previas
    // (el supervisor puede reintentar manualmente desde su panel)
    if (sale.sync_status !== 'pending') continue;

    const result = await _syncOne(sale);
    result.success ? synced++ : failed++;
  }

  _isSyncing = false;
  _notifyUpdate();

  console.log(`Sync completado: ${synced} exitosas, ${failed} fallidas`);
  return { synced, failed };
}

// Reintenta TODAS las ventas, incluyendo las marcadas como 'failed'
// Solo el supervisor puede llamar esto
async function syncRetryAll() {
  if (_isSyncing) return;
  if (!navigator.onLine) return;

  const all = await pendingSaleGetAll();
  if (all.length === 0) return;

  _isSyncing = true;
  _notifyUpdate();

  let synced = 0;
  let failed = 0;

  for (const sale of all) {
    // Resetear estado para reintentar
    sale.sync_status = 'pending';
    const result = await _syncOne(sale);
    result.success ? synced++ : failed++;
  }

  _isSyncing = false;
  _notifyUpdate();

  return { synced, failed };
}

// ─── ESTADO PÚBLICO ───────────────────────────────────────────────────────────

function isSyncing() {
  return _isSyncing;
}

// ─── SINCRONIZAR ENTRADAS DE MATERIA PRIMA ────────────────────────────────────

async function _syncOneMaterialEntry(entry) {
  try {
    const record = {
      id:            entry.id,
      type:          entry.type,
      receipt_date:  entry.receipt_date,
      month:         entry.month,
      weight_lbs:    entry.weight_lbs,
      notes:         entry.notes || '',
      operator_name: entry.operator_name || '',
      provider:      entry.provider || '',
      status:        'pending',
      created_at:    entry.created_at || new Date().toISOString(),
    };

    const { error } = await supabaseRequest('material_receipts', {
      method: 'POST',
      body:   record,
      prefer: 'return=minimal'
    });

    if (error) throw new Error(JSON.stringify(error));

    await pendingMaterialEntryRemove(entry.id);
    return { success: true };

  } catch (err) {
    console.error(`_syncOneMaterialEntry: falló entrada ${entry.id}:`, err.message);
    return { success: false, error: err.message };
  }
}

async function syncMaterialEntries() {
  if (!navigator.onLine) return;

  const pending = await pendingMaterialEntryGetAll();
  if (pending.length === 0) return;

  for (const entry of pending) {
    if (entry.sync_status !== 'pending') continue;
    await _syncOneMaterialEntry(entry);
  }
}

// ─── SINCRONIZAR PESOS DE PAQUETES ────────────────────────────────────────────

async function _syncOnePackageWeight(entry) {
  try {
    const record = {
      id:            entry.id,
      weight_lbs:    entry.weight_lbs,
      operator_name: entry.operator_name || '',
      shift_date:    entry.shift_date,
      notes:         entry.notes || '',
      created_at:    entry.created_at || new Date().toISOString(),
    };

    const { error } = await supabaseRequest('package_weights', {
      method: 'POST',
      body:   record,
      prefer: 'return=minimal'
    });

    if (error) throw new Error(JSON.stringify(error));

    await pendingPackageWeightRemove(entry.id);
    return { success: true };

  } catch (err) {
    console.error(`_syncOnePackageWeight: falló entrada ${entry.id}:`, err.message);
    return { success: false, error: err.message };
  }
}

async function syncPackageWeights() {
  if (!navigator.onLine) return;

  const pending = await pendingPackageWeightGetAll();
  if (pending.length === 0) return;

  for (const entry of pending) {
    if (entry.sync_status !== 'pending') continue;
    await _syncOnePackageWeight(entry);
  }
}

// ─── LISTENERS DE RED ─────────────────────────────────────────────────────────
// Cuando el dispositivo recupera internet, sincroniza automáticamente

window.addEventListener('online', () => {
  console.log('Conexión restaurada — sincronizando ventas pendientes...');
  syncPendingSales();
  syncMaterialEntries();
  syncPackageWeights();
});
