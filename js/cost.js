// ─── COST.JS ─────────────────────────────────────────────────────────────────
// Replica la lógica de computeMonthlyCostPerPackage de CapFlow.
// Calcula el costo real por paquete del mes usando:
//   - Registros de producción     (tabla: production)
//   - Compras de materia prima    (tabla: raw_materials)
//   - Inventarios mensuales       (tabla: monthly_inventory)
//
// Los datos se cargan desde Supabase y se guardan en caché (IndexedDB)
// para que el cálculo funcione también en modo offline.

// ─── CARGA DE DATOS ──────────────────────────────────────────────────────────

// Carga y cachea los datos necesarios para el cálculo de costos.
// Si está offline, intenta usar el caché existente.
// Devuelve { production, purchases, monthlyInventory } o null si no hay datos.
async function loadCostData(month) {
  const cacheKey = `cost_data_${month}`;

  // Intentar cargar desde Supabase
  try {
    const [prodRes, matRes, invRes] = await Promise.all([
      supabaseRequest(`production?month=eq.${month}&select=quantity,operator_rate_snapshot,production_date,month`),
      supabaseRequest(`raw_materials?month=eq.${month}&select=month,type,weight_lbs,washed_weight_lbs,cost,washing_cost`),
      // Necesitamos el mes actual y el anterior para el cálculo de inventario
      supabaseRequest(`monthly_inventory?month=in.(${month},${_prevMonthString(month)})&select=month,recycled_closing_lbs,pellet_closing_lbs`)
    ]);

    // Si cualquiera falló por red, caer en caché
    if (
      prodRes.error?.offline ||
      matRes.error?.offline ||
      invRes.error?.offline
    ) {
      return await cacheGet(cacheKey);
    }

    // Mapear snake_case → camelCase igual que hace CapFlow en api.js
    const production = (prodRes.data || []).map(r => ({
      quantity:             Number(r.quantity) || 0,
      operatorRateSnapshot: r.operator_rate_snapshot?.operator_rate_snapshot || 0,
      productionDate:       r.production_date || null,
      month:                r.month || null
    }));

    const purchases = (matRes.data || []).map(r => ({
      month:           r.month,
      materialType:    r.type,
      weightLbs:       Number(r.weight_lbs)    || 0,
      washedWeightLbs: Number(r.washed_weight_lbs) || 0,
      totalCost:       Number(r.cost)          || 0,
      washingCost:     Number(r.washing_cost)  || 0
    }));

    const monthlyInventory = (invRes.data || []).map(r => ({
      month:              r.month,
      recycledClosingLbs: Number(r.recycled_closing_lbs) || 0,
      pelletClosingLbs:   Number(r.pellet_closing_lbs)   || 0
    }));

    const costData = { production, purchases, monthlyInventory };

    // Guardar en caché para uso offline
    await cacheSet(cacheKey, costData);

    return costData;

  } catch (err) {
    // Error inesperado — intentar caché
    console.warn('loadCostData: error inesperado, usando caché', err);
    return await cacheGet(cacheKey);
  }
}

// ─── CÁLCULO PRINCIPAL ───────────────────────────────────────────────────────

// Réplica exacta de computeMonthlyCostPerPackage de CapFlow.
// Recibe los datos ya cargados y calcula el costo por paquete del mes.
//
// Devuelve: { costPerPackage: number, missing: boolean }
//   missing = true  → no hay datos suficientes para calcular (costo = 0)
//   missing = false → cálculo exitoso
function _computeCostPerPackage(month, production, purchases, monthlyInventory) {
  const monthRecords = production.filter(r =>
    (r.month || r.productionDate?.slice(0, 7)) === month
  );
  const totalPkgs = monthRecords.reduce((s, r) => s + r.quantity, 0);

  if (totalPkgs === 0) return { costPerPackage: 0, missing: true };

  // Costo de mano de obra
  const laborCost = monthRecords.reduce((s, r) =>
    s + r.operatorRateSnapshot * r.quantity, 0
  );

  // Inventarios del mes anterior y actual
  const prevMonth = _prevMonthString(month);
  const prevInv   = monthlyInventory.find(i => i.month === prevMonth);
  const currInv   = monthlyInventory.find(i => i.month === month);

  // Costo de materiales (reciclado + pellet)
  const materialCost = ['recycled', 'pellet'].reduce((acc, type) => {
    const typePurchases = purchases.filter(p =>
      p.month === month && p.materialType === type
    );

    const pLbs  = typePurchases.reduce((s, p) =>
      s + (p.washedWeightLbs || p.weightLbs || 0), 0
    );
    const pCost = typePurchases.reduce((s, p) =>
      s + (p.totalCost || 0) + (p.washingCost || 0), 0
    );

    const avgCost  = pLbs > 0 ? pCost / pLbs : 0;
    const key      = type === 'recycled' ? 'recycledClosingLbs' : 'pelletClosingLbs';
    const openLbs  = prevInv ? (prevInv[key] || 0) : 0;
    const closeLbs = currInv ? (currInv[key] || 0) : 0;

    return acc + (openLbs + pLbs - closeLbs) * avgCost;
  }, 0);

  const totalCost      = laborCost + materialCost;
  const costPerPackage = totalPkgs > 0 ? totalCost / totalPkgs : 0;

  return { costPerPackage, missing: costPerPackage === 0 };
}

// ─── API PÚBLICA ──────────────────────────────────────────────────────────────

// Función principal que usan los demás módulos.
// Carga los datos, ejecuta el cálculo y devuelve el resultado.
//
// Devuelve: { costPerPackage: number, missing: boolean }
async function computeCostForMonth(month) {
  const costData = await loadCostData(month);

  if (!costData) {
    console.warn(`computeCostForMonth: no hay datos para ${month}`);
    return { costPerPackage: 0, missing: true };
  }

  return _computeCostPerPackage(
    month,
    costData.production,
    costData.purchases,
    costData.monthlyInventory
  );
}

// ─── HELPER ───────────────────────────────────────────────────────────────────

// Réplica exacta de _prevMonthString de CapFlow
function _prevMonthString(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, '0')}`;
}
