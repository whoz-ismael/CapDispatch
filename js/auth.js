// ─── AUTH.JS ──────────────────────────────────────────────────────────────────
// Maneja la autenticación por PIN y la sesión activa.
//
// La sesión se guarda en sessionStorage para que:
//   - Sobreviva recargas accidentales de la página
//   - Se borre automáticamente cuando se cierra el navegador
//
// Flujo:
//   1. Al abrir la app → verificar si hay sesión activa
//   2. Si no → mostrar pantalla de PIN
//   3. Al ingresar PIN → buscar operario, comparar hash, guardar sesión
//   4. Al cerrar sesión → limpiar sessionStorage y volver al PIN

const SESSION_KEY = 'capdispatch_session';

// ─── SESIÓN EN MEMORIA ────────────────────────────────────────────────────────
// Copia en memoria para acceso rápido sin leer sessionStorage en cada llamada
let _currentUser = null;

// ─── CARGAR OPERARIOS ─────────────────────────────────────────────────────────
// Carga los operarios activos desde Supabase y los cachea en IndexedDB.
// Si está offline, usa el caché existente.
async function loadOperators() {
  const { data, error } = await supabaseRequest(
    'dispatch_operators?is_active=eq.true&select=id,name,pin_hash,role'
  );

  if (error?.offline) {
    // Sin internet — usar caché
    const cached = await cacheGet('operators');
    return cached || [];
  }

  if (error || !data) return [];

  // Guardar en caché para uso offline
  await cacheSet('operators', data);
  return data;
}

// ─── VALIDAR PIN ──────────────────────────────────────────────────────────────
// Recibe el PIN ingresado, lo hashea y lo compara con los operarios cargados.
// Devuelve { success, user, error }
async function validatePin(pin) {
  if (!pin || pin.trim() === '') {
    return { success: false, error: 'Ingresa tu PIN' };
  }

  const operators = await loadOperators();

  if (operators.length === 0) {
    return { success: false, error: 'No se pudieron cargar los operarios' };
  }

  const pinHash = await hashPin(pin.trim());
  const match   = operators.find(op => op.pin_hash === pinHash);

  if (!match) {
    return { success: false, error: 'PIN incorrecto' };
  }

  // Crear sesión
  const session = {
    id:         match.id,
    name:       match.name,
    role:       match.role,
    loggedInAt: Date.now()
  };

  // Guardar en sessionStorage y en memoria
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  _currentUser = session;

  return { success: true, user: session };
}

// ─── SESIÓN ACTIVA ────────────────────────────────────────────────────────────

// Devuelve el usuario actual o null si no hay sesión
function getCurrentUser() {
  if (_currentUser) return _currentUser;

  const stored = sessionStorage.getItem(SESSION_KEY);
  if (!stored) return null;

  try {
    _currentUser = JSON.parse(stored);
    return _currentUser;
  } catch {
    return null;
  }
}

// Verifica si hay una sesión activa
function isLoggedIn() {
  return getCurrentUser() !== null;
}

// Verifica si el usuario actual es supervisor
function isSupervisor() {
  const user = getCurrentUser();
  return user?.role === ROLES.SUPERVISOR;
}

// ─── CERRAR SESIÓN ────────────────────────────────────────────────────────────

function logout() {
  sessionStorage.removeItem(SESSION_KEY);
  _currentUser = null;
}

// ─── GESTIÓN DE OPERARIOS (solo supervisores) ─────────────────────────────────

// Crea un nuevo operario o supervisor
// Devuelve { success, error }
async function createOperator({ name, pin, role }) {
  if (!name || !pin || !role) {
    return { success: false, error: 'Nombre, PIN y rol son requeridos' };
  }

  if (pin.length < 4) {
    return { success: false, error: 'El PIN debe tener al menos 4 dígitos' };
  }

  // Verificar que el PIN no esté en uso
  const operators = await loadOperators();
  const pinHash   = await hashPin(pin.trim());
  const duplicate = operators.find(op => op.pin_hash === pinHash);

  if (duplicate) {
    return { success: false, error: 'Ese PIN ya está en uso por otro operario' };
  }

  const newOperator = {
    id:         generateId('op'),
    name:       name.trim(),
    pin_hash:   pinHash,
    role:       role,
    is_active:  true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { error } = await supabaseRequest('dispatch_operators', {
    method: 'POST',
    body:   newOperator,
    prefer: 'return=minimal'
  });

  if (error) {
    return { success: false, error: 'Error al crear el operario' };
  }

  // Refrescar caché
  await loadOperators();
  return { success: true };
}

// Desactiva un operario (no lo elimina, solo lo marca inactivo)
async function deactivateOperator(operatorId) {
  const { error } = await supabaseRequest(
    `dispatch_operators?id=eq.${operatorId}`,
    {
      method: 'PATCH',
      body:   { is_active: false, updated_at: new Date().toISOString() },
      prefer: 'return=minimal'
    }
  );

  if (error) return { success: false, error: 'Error al desactivar el operario' };

  // Refrescar caché
  await loadOperators();
  return { success: true };
}

// Actualiza el PIN de un operario existente
// Devuelve { success, error }
async function updateOperatorPin(operatorId, newPin) {
  if (!newPin || newPin.length < 4) {
    return { success: false, error: 'El PIN debe tener al menos 4 dígitos' };
  }

  const operators = await loadOperators();
  const pinHash   = await hashPin(newPin.trim());
  const duplicate = operators.find(op => op.pin_hash === pinHash && op.id !== operatorId);

  if (duplicate) {
    return { success: false, error: 'Ese PIN ya está en uso por otro operario' };
  }

  const { error } = await supabaseRequest(
    `dispatch_operators?id=eq.${operatorId}`,
    {
      method: 'PATCH',
      body:   { pin_hash: pinHash, updated_at: new Date().toISOString() },
      prefer: 'return=minimal'
    }
  );

  if (error) return { success: false, error: 'Error al actualizar el PIN' };

  await loadOperators();
  return { success: true };
}

// Lista todos los operarios activos (para el panel del supervisor)
async function listOperators() {
  const { data, error } = await supabaseRequest(
    'dispatch_operators?is_active=eq.true&select=id,name,role,created_at&order=created_at.asc'
  );

  if (error) return [];
  return data || [];
}
