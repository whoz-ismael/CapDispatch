// ─── SUPABASE ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://cyzrxztodzivbxrivkot.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5enJ4enRvZHppdmJ4cml2a290Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE3NjgwODAsImV4cCI6MjA4NzM0NDA4MH0.Ij3BFNwQiMYNVeBOYJ8T5knswO2pJWOp6Z51IiJ3mYg';

// ─── CLIENTES ─────────────────────────────────────────────────────────────────
const GENERIC_CUSTOMER_ID = 'customer-generico';

// ─── PRECIOS ──────────────────────────────────────────────────────────────────
const DEFAULT_PRODUCT_PRICE = 900;

// ─── FACTURACIÓN ──────────────────────────────────────────────────────────────
const INVOICE_PREFIX = 'DISP-';

// ─── ROLES ────────────────────────────────────────────────────────────────────
const ROLES = {
  OPERATOR: 'operator',
  SUPERVISOR: 'supervisor'
};

// ─── HELPER: peticiones a Supabase ───────────────────────────────────────────
// Función base para todas las llamadas a la API de Supabase.
// Devuelve { data, error } igual que el cliente oficial de Supabase.
async function supabaseRequest(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': options.prefer || 'return=representation',
    ...options.headers
  };

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    // Supabase devuelve 204 en deletes/updates sin cuerpo
    if (response.status === 204) return { data: null, error: null };

    const json = await response.json();

    if (!response.ok) {
      return { data: null, error: json };
    }

    return { data: json, error: null };
  } catch (err) {
    // Error de red — probablemente offline
    return { data: null, error: { message: 'offline', offline: true } };
  }
}

// ─── HELPER: generar IDs únicos ───────────────────────────────────────────────
// Mismo formato que usa CapFlow: timestamp + string aleatorio
function generateId(prefix = 'disp') {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${ts}-${rand}`;
}

// ─── HELPER: obtener mes actual en formato YYYY-MM ────────────────────────────
function getCurrentMonth() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ─── HELPER: obtener fecha actual en formato YYYY-MM-DD ───────────────────────
function getCurrentDate() {
  return new Date().toISOString().slice(0, 10);
}

// ─── HELPER: hash SHA-256 para PINs ──────────────────────────────────────────
async function hashPin(pin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
