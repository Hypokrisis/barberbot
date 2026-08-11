// Polyfill WebSocket for Node.js < 22 (required by Supabase realtime)
if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const Groq = require('groq-sdk');
const cron = require('node-cron');
const bookingLogic = require('./booking-logic');

// ── Environment validation ───────────────────────────────────────────────────
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://spaceyreserve.netlify.app';

const requiredEnvVars = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM',
  'GROQ_API_KEY', 'WEBHOOK_URL'
];
const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error('❌ Missing env vars:', missingEnvVars.join(', '));
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Clients ──────────────────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Session store (Supabase-backed, in-memory cache) ─────────────────────────
// Survives Railway restarts. TTL: 30 min inactivity.
// FIX 3 — La sesión se llave por (business_id, phone), NO solo por phone: un mismo
// cliente que escribe a 2 barberías (2 números Twilio) debe tener una sesión
// SEPARADA por negocio. Antes compartían una sola → el bk (barberId/serviceId) de
// un negocio se filtraba al otro. Requiere bot_sessions con (phone, business_id) único.
const sessions = {}; // in-memory cache: `${businessId}:${phone}` → session
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes
const sessKey = (phone, businessId) => `${businessId}:${phone}`;

async function getSession(phone, businessId) {
  const now = Date.now();
  const key = sessKey(phone, businessId);

  // 1. Check warm cache
  if (sessions[key]) {
    if (now - sessions[key].lastActivity > SESSION_TTL) {
      delete sessions[key]; // expired in cache
    } else {
      sessions[key].lastActivity = now;
      return sessions[key];
    }
  }

  // 2. Load from Supabase
  try {
    const { data } = await supabase
      .from('bot_sessions')
      .select('state, data, history, updated_at')
      .eq('phone', phone)
      .eq('business_id', businessId)
      .maybeSingle();

    if (data) {
      const lastActivity = new Date(data.updated_at).getTime();
      if (now - lastActivity <= SESSION_TTL) {
        const session = {
          state: data.state,
          data: data.data || {},
          history: data.history || [],
          lastActivity: now,
        };
        sessions[key] = session;
        return session;
      }
    }
  } catch (err) {
    console.error('[Session] DB load error, using fresh session:', err.message);
  }

  // 3. New / expired session
  const fresh = { state: 'idle', data: {}, history: [], lastActivity: now };
  sessions[key] = fresh;
  return fresh;
}

async function saveSession(phone, session, businessId) {
  session.lastActivity = Date.now();
  sessions[sessKey(phone, businessId)] = session; // keep cache warm

  try {
    await supabase
      .from('bot_sessions')
      .upsert({
        phone,
        business_id: businessId,
        state: session.state,
        data: session.data,
        history: session.history || [],
        updated_at: new Date().toISOString(),
      }, { onConflict: 'phone,business_id' });
  } catch (err) {
    console.error('[Session] DB save error (non-fatal):', err.message);
    // Non-fatal: in-memory cache still works until restart
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────
// Puerto Rico is UTC-4 year-round (no DST)
function todayPR() {
  const now = new Date();
  const prTime = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  return prTime.toISOString().split('T')[0];
}

function nowTimePR() {
  return new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString().split('T')[1].slice(0, 5);
}

function formatDate(dateStr) {
  const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto',
                  'septiembre','octubre','noviembre','diciembre'];
  const days = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const d = new Date(dateStr + 'T12:00:00');
  return `${days[d.getDay()]} ${d.getDate()} de ${months[d.getMonth()]}`;
}

function formatTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2,'0')} ${period}`;
}

// ── Tier helpers ──────────────────────────────────────────────────────────────
function getPlan(business) {
  return (business?.plan_status || 'basic').toLowerCase();
}

function canUseGroq(business) {
  const plan = getPlan(business);
  return plan === 'pro' || plan === 'premium';
}

function canSendReports(business) {
  const plan = getPlan(business);
  return plan === 'pro' || plan === 'premium';
}

// Link de reservas del negocio (multi-tenant). Prioriza el link propio; si no,
// /book/<slug>; si tampoco hay slug, cae al sitio genérico de la plataforma.
// NUNCA debe apuntar a un negocio específico por defecto.
function bookingLinkFor(business) {
  if (business && business.whatsapp_booking_link) return business.whatsapp_booking_link;
  if (business && business.slug) return `${FRONTEND_URL}/book/${business.slug}`;
  return FRONTEND_URL;
}

function canSendProactive(business) {
  return getPlan(business) === 'premium';
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function getBusinessInfo(businessId) {
  const { data: business } = await supabase
    .from('businesses').select('*').eq('id', businessId).single();
  const { data: allBarbers } = await supabase
    .from('barbers').select('id,name,phone_e164')
    .eq('business_id', businessId).eq('is_active', true);
  const { data: services } = await supabase
    .from('services').select('id,name,duration_minutes,price')
    .eq('business_id', businessId).eq('is_active', true);

  // Solo barberos RESERVABLES: activos Y con al menos un horario activo (FALLO 4)
  const ids = (allBarbers || []).map(b => b.id);
  let barbers = allBarbers || [];
  if (ids.length) {
    const { data: scheds } = await supabase
      .from('schedules').select('barber_id').eq('is_active', true).in('barber_id', ids);
    const withSched = new Set((scheds || []).map(s => s.barber_id));
    const bookable = barbers.filter(b => withSched.has(b.id));
    if (bookable.length) barbers = bookable; // si ninguno tiene horario, no rompas el flujo
  }
  return { business, barbers, services };
}

// Próxima disponibilidad real de un barbero: hasta `maxDays` días con cupos,
// `perDay` horas repartidas por día. Hoy solo cuenta horas futuras.
async function getUpcoming(barberId, maxDays = 2, perDay = 2) {
  const out = [];
  const todayStr = todayPR();
  const nowPR = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const nowMin = nowPR.getUTCHours() * 60 + nowPR.getUTCMinutes();
  const base = new Date(todayStr + 'T12:00:00');
  for (let offset = 0; offset <= 14 && out.length < maxDays; offset++) {
    const d = new Date(base); d.setDate(base.getDate() + offset);
    const dateStr = d.toISOString().split('T')[0];
    let slots = await getAvailableSlots(barberId, dateStr);
    if (offset === 0) slots = slots.filter(s => { const [h, m] = s.split(':').map(Number); return h * 60 + m > nowMin + 15; });
    if (slots.length) {
      const pick = [];
      const step = Math.max(1, Math.floor(slots.length / perDay));
      for (let i = 0; i < slots.length && pick.length < perDay; i += step) pick.push(slots[i]);
      out.push({ date: dateStr, slots: pick });
    }
  }
  return out;
}

async function getOwnerPhone(business) {
  if (!business?.owner_id) return null;
  const { data: profile } = await supabase
    .from('profiles').select('phone').eq('id', business.owner_id).maybeSingle();
  return profile?.phone || null;
}

// Panorama real del día para un barbero: ventana abre–cierra, slots libres y
// ocupados. Fuente única de verdad para disponibilidad (Punto 2 del rediseño).
async function getDayAvailability(barberId, date) {
  const dow = new Date(date + 'T12:00:00').getDay();
  const { data: schedule } = await supabase
    .from('schedules').select('start_time,end_time')
    .eq('barber_id', barberId).eq('day_of_week', dow).eq('is_active', true)
    .maybeSingle();
  if (!schedule) return { closed: true, open: null, close: null, available: [], booked: [] };

  const { data: appointments } = await supabase
    .from('appointments').select('start_time,end_time')
    .eq('barber_id', barberId).eq('appointment_date', date).neq('status', 'cancelled');

  const open = schedule.start_time.slice(0, 5);
  const close = schedule.end_time.slice(0, 5);
  const bookedSet = new Set((appointments || []).map(a => a.start_time.slice(0, 5)));
  const available = [], booked = [];
  let [sh, sm] = schedule.start_time.split(':').map(Number);
  const [eh, em] = schedule.end_time.split(':').map(Number);
  const endMins = eh * 60 + em;
  while (sh * 60 + sm + 30 <= endMins) {
    const slotStart = `${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`;
    if (bookedSet.has(slotStart)) booked.push(slotStart);
    else available.push(slotStart);
    sm += 30;
    if (sm >= 60) { sh++; sm -= 60; }
  }
  return { closed: false, open, close, available, booked };
}

// Compat: la mayoría del código solo necesita la lista de slots libres.
async function getAvailableSlots(barberId, date) {
  return (await getDayAvailability(barberId, date)).available;
}

const _toMinIdx = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// Clasifica una hora puntual contra el horario real + citas. Devuelve uno de:
// available | booked | unaligned | outside_hours | closed | past
// (Punto 2 y 4: distingue "ocupada" de "fuera de horario" y verifica vs DB).
async function checkSlot(barberId, date, time) {
  const day = await getDayAvailability(barberId, date);
  const base = { open: day.open, close: day.close, available: day.available };
  if (day.closed) return { status: 'closed', ...base };

  if (date === todayPR()) {
    const nowPR = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const nowMin = nowPR.getUTCHours() * 60 + nowPR.getUTCMinutes();
    if (_toMinIdx(time) <= nowMin + 15) return { status: 'past', ...base };
  }
  const tMin = _toMinIdx(time);
  if (tMin < _toMinIdx(day.open) || tMin + 30 > _toMinIdx(day.close)) {
    return { status: 'outside_hours', ...base };
  }
  if (day.available.includes(time)) return { status: 'available', ...base };
  if (day.booked.includes(time))    return { status: 'booked', ...base };
  return { status: 'unaligned', ...base }; // dentro de horario pero no cae en slot de 30 min
}

// Resumen del horario semanal de un barbero (1 query, sin citas) para el prompt
// de Groq: permite desambiguar AM/PM y detectar fuera de horario.
async function getBarberHours(barberId) {
  const { data } = await supabase
    .from('schedules').select('day_of_week,start_time,end_time')
    .eq('barber_id', barberId).eq('is_active', true);
  const map = {};
  (data || []).forEach(s => { map[s.day_of_week] = { open: s.start_time.slice(0, 5), close: s.end_time.slice(0, 5) }; });
  return map;
}

// Normaliza teléfono a solo dígitos para comparar
function normalizePhone(phone) {
  return phone.replace(/\D/g, '');
}

// Normaliza a E.164 para usarlo como identidad universal del cliente.
// 10 dígitos -> +1XXXXXXXXXX | 11 empezando en 1 -> +1XXXXXXXXXX | otro -> tal cual.
function normalizePhoneE164(phone) {
  if (!phone) return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone;
}

// Busca si el teléfono corresponde a un usuario registrado en Spacey
async function findRegisteredUser(phone) {
  const normalized = normalizePhone(phone);
  // Pre-filtro barato por los últimos 4 dígitos (contiguos en cualquier formato:
  // "939 316 7853", "(939) 316-7853", etc.) para no bajar toda la tabla profiles.
  // El match real se valida en JS abajo. No tiene que ser perfecto, solo reduce el scan.
  const last4 = normalized.slice(-4);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, full_name, phone')
    .not('phone', 'is', null)
    .ilike('phone', `%${last4}%`);

  if (!profiles) return null;
  // Comparar por los últimos 10 dígitos: el bot recibe +1XXXXXXXXXX (11 dígitos con
  // el 1) y profiles guarda 10 dígitos sin el 1, así que comparar el string completo
  // fallaba siempre. Los últimos 10 son la identidad real del número PR/USA.
  return profiles.find(p => normalizePhone(p.phone || '').slice(-10) === normalized.slice(-10)) || null;
}

async function createAppointment(data) {
  // Intentar linkear con usuario registrado por teléfono
  const registeredUser = await findRegisteredUser(data.customerPhone);

  const payload = {
    business_id: data.businessId,
    barber_id: data.barberId,
    service_id: data.serviceId,
    customer_name: data.customerName,
    customer_phone: normalizePhoneE164(data.customerPhone),
    appointment_date: data.date,
    start_time: data.startTime,
    end_time: data.endTime,
    status: 'confirmed',
    // Sin cuenta vinculada => invitado. Se persiste (antes solo se calculaba).
    is_guest: !registeredUser,
  };

  // Si el usuario tiene cuenta, vincular la cita a su perfil
  if (registeredUser) {
    payload.client_id = registeredUser.id;
    payload.customer_user_id = registeredUser.id;
  }

  const { data: appt, error } = await supabase
    .from('appointments').insert(payload).select().single();
  return { appt, error, isGuest: !registeredUser };
}

async function getAllActiveAppointments(phone, businessId) {
  const todayStr = todayPR();
  const { data } = await supabase
    .from('appointments')
    .select('id, customer_name, appointment_date, start_time, barber_id, service_id')
    .eq('business_id', businessId)
    .eq('customer_phone', phone)
    .eq('status', 'confirmed')
    .gte('appointment_date', todayStr)
    .order('appointment_date', { ascending: true });
  const nowTime = nowTimePR();
  return (data || []).filter(a =>
    a.appointment_date > todayStr ||
    a.start_time.slice(0, 5) >= nowTime
  );
}

// PASO 0 del flujo: el número de WhatsApp es el identificador universal.
// Busca historial en appointments sin importar si la cita vino del bot, web o dashboard.
async function getClientHistory(phone, businessId) {
  const todayStr = todayPR();
  const { data } = await supabase
    .from('appointments')
    .select('customer_name, appointment_date, start_time, barber_id, service_id, status')
    .eq('business_id', businessId)
    .eq('customer_phone', phone)
    .order('appointment_date', { ascending: false })
    .limit(20);

  if (!data || !data.length) return { hasHistory: false };

  const name = data.find(a => a.customer_name)?.customer_name || null;
  const nowTime = nowTimePR();
  const activeAppointment = data
    .filter(a => a.status === 'confirmed' && (
      a.appointment_date > todayStr ||
      (a.appointment_date === todayStr && a.start_time.slice(0, 5) >= nowTime)
    ))
    .sort((a, b) => (a.appointment_date < b.appointment_date ? -1 : 1))[0] || null;

  return { hasHistory: true, name, activeAppointment };
}

async function sendWhatsApp(to, body, client = twilioClient, from = process.env.TWILIO_WHATSAPP_FROM) {
  // Log de SALIDA: cada respuesta del bot queda en los logs de Railway (regla de
  // oro). Así un fallo en vivo se diagnostica sin depender del CSV de Twilio.
  console.log(`[${to}] → ${body}`);
  await client.messages.create({
    from,
    to: `whatsapp:${to}`,
    body
  });
}

// Envía una plantilla aprobada de WhatsApp (necesaria para mensajes iniciados por
// el negocio fuera de la ventana de 24h, como los recordatorios). `vars` mapea
// las variables de la plantilla: { "1": ..., "2": ... }.
async function sendTemplate(to, contentSid, vars, client = twilioClient, from = process.env.TWILIO_WHATSAPP_FROM) {
  await client.messages.create({
    from,
    to: `whatsapp:${to}`,
    contentSid,
    contentVariables: JSON.stringify(vars),
  });
}

// ── Groq — "cerebro" del bot: UNA llamada devuelve intención + datos de cita ───
// Reemplaza classifyIntent + extractBooking (antes 2 llamadas). Sin regex.
// REGLA #2: el prompt SIEMPRE incluye el estado del bot y lo que se le acaba de
// mostrar al cliente (las opciones), para que "hoy", "3:30", "el primero" se
// entiendan en contexto.
async function understand(message, services, barbers, state, offeredCtx, hoursCtx) {
  const svc = services.map(s => s.name).join(', ');
  const bar = barbers.map(b => b.name).join(', ');
  const inFlow = ['collecting', 'picking_slot', 'confirming', 'rescheduling'].includes(state);
  const hint = ({
    collecting:   'El bot está juntando nombre, servicio y barbero. Si una palabra suelta coincide con un barbero de la lista, ponla en "barber"; si coincide con un servicio, en "service"; si no coincide con ninguno, es el nombre del cliente ("name").',
    picking_slot: 'El bot ofreció horarios. Un número, una hora o una posición ("el primero") es la elección (intent NUEVA_CITA).',
    rescheduling: 'El bot ofreció horarios para reagendar. Un número, una hora o una posición ("el primero") es la elección.',
    confirming:   'El bot pidió confirmar (sí/no). "sí/dale/ok/eso/va/perfecto"=CONFIRMAR, "no/mejor no/nah/qué va"=NEGAR.',
  })[state] || '';

  const offered = offeredCtx
    ? `\nOpciones que se le acaban de mostrar al cliente (en orden, 1-based): ${offeredCtx}. Si dice "el primero"/"la segunda"/"ese"/"la última" SIN mencionar una hora, devuelve "choice" con esa posición.`
    : '';
  const hours = hoursCtx ? `\nHorario del barbero: ${hoursCtx}. Úsalo para interpretar la hora.` : '';

  // Calendario de referencia: el modelo NUNCA hace aritmética de fechas; copia la
  // fecha YYYY-MM-DD EXACTA de esta tabla cuando el cliente menciona un día. 8 días
  // (hoy + 7) cubren las 7 etiquetas de día de la semana sin ambigüedad.
  const dows = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const baseToday = new Date(todayPR() + 'T12:00:00');
  const calRows = [];
  for (let off = 0; off <= 7; off++) {
    const dd = new Date(baseToday); dd.setDate(baseToday.getDate() + off);
    const ds = dd.toISOString().split('T')[0];
    const alias = off === 0 ? `hoy (${dows[dd.getDay()]})` : off === 1 ? `mañana (${dows[dd.getDay()]})` : dows[dd.getDay()];
    calRows.push(`${alias} = ${ds}`);
  }
  const calendar = `\nHoy es ${dows[baseToday.getDay()]} ${todayPR()}. Calendario de referencia (usa la fecha EXACTA YYYY-MM-DD de esta tabla):\n${calRows.join('\n')}`;

  const sys = `Eres el cerebro de un bot de citas de barbería en Puerto Rico. Analiza el mensaje EN CONTEXTO y devuelve SOLO JSON:
{"intent":"NUEVA_CITA|REAGENDAR|CANCELAR|VER_CITA|CONFIRMAR|NEGAR|PREGUNTA_GENERAL|FUERA_DE_CONTEXTO|UNKNOWN","name":string|null,"service":string|null,"barber":string|null,"date":string|null,"time":string|null,"choice":number|null,"ampm_ambiguous":boolean}

PASO 1 — ¿el mensaje es sobre la barbería? Relacionado = reservar/reagendar/cancelar, preguntar por servicios/precios/horarios/ubicación/barberos, o una respuesta dentro del flujo activo. NO relacionado = otros temas (clima, matemáticas, etc.), preguntas sobre "Spacey Reserve" como plataforma, spam, o números/saludos raros sin flujo activo → intent="FUERA_DE_CONTEXTO".
IMPORTANTE: un saludo ("hola","buenas","qué tal","hey") o preguntar por disponibilidad/horarios/precios/servicios SIEMPRE es sobre la barbería — NUNCA lo marques FUERA_DE_CONTEXTO (usa UNKNOWN, PREGUNTA_GENERAL o NUEVA_CITA).
${inFlow ? 'OJO: el cliente está EN MEDIO de un flujo activo. Un mensaje corto o ambiguo ("nah","ese","las 6","ok","el azul") casi siempre es una respuesta al flujo — interprétalo como tal ANTES de marcarlo FUERA_DE_CONTEXTO. Solo usa FUERA_DE_CONTEXTO si es CLARAMENTE ajeno (ej "ayúdame con mate").' : ''}

intent (si es sobre la barbería):
- REAGENDAR: cambiar/mover/reprogramar una cita (ej "cambiar mi cita","no puedo ir a esa hora","hay algo más tarde")
- CANCELAR: cancelar/borrar una cita (ej "cancela","ya no puedo ir","olvídalo","borra mi cita")
- VER_CITA: preguntar cuándo es su cita (ej "cuándo es mi cita","a qué hora tengo")
- NUEVA_CITA: quiere agendar o da datos de una cita
- CONFIRMAR: afirmación (sí, dale, ok, eso, va, perfecto, confirmo, claro)
- NEGAR: negación (no, mejor no, nada, nah, qué va, olvídalo)
- PREGUNTA_GENERAL: precios, horarios, ubicación, servicios
- UNKNOWN: sobre la barbería pero no está claro qué quiere
name: nombre del cliente si aparece. null si no.
service: SOLO de esta lista exacta: ${svc}. null si no lo menciona.
barber: el barbero que el cliente pide o nombra, SOLO de esta lista: ${bar || 'ninguno'}. Si el mensaje es solo un nombre de esa lista ("pacheco","pablo","con pepe"), DEVUÉLVELO aquí. null si no nombra a ninguno.
date: SIEMPRE en formato YYYY-MM-DD tomado del calendario de referencia de abajo. Si el cliente menciona un día ("lunes","el sábado","mañana","hoy","este lunes"), busca esa fila y devuelve su fecha EXACTA. NUNCA devuelvas "lunes","monday","mañana" ni texto libre: solo YYYY-MM-DD o null.
time: la hora EXACTA que pidió el cliente, en "HH:MM" 24h. null si no menciona hora.
  · Si menciona una hora ("6pm","las 6","a las 10"), SIEMPRE ponla en "time" y NO uses "choice".
  · NUNCA ajustes/redondees la hora a una opción de la lista: devuelve la hora LITERAL que pidió.
  · Desambigua AM/PM con el horario del barbero (ej "las 6" con horario 10:00–19:00 → "18:00").
choice: posición 1-based SOLO si elige por orden sin mencionar hora ("el primero"=1). null si menciona una hora.
ampm_ambiguous: true SOLO si la hora cabe tanto en AM como en PM dentro del horario y no puedes decidir; si no, false.
Estado actual del bot: ${state}.${hint ? ' ' + hint : ''}${hours}${offered}${calendar}
No inventes datos que no estén en el mensaje.`;

  try {
    const c = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: message }],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    });
    const j = JSON.parse(c.choices[0].message.content) || {};
    const valid = ['NUEVA_CITA','REAGENDAR','CANCELAR','VER_CITA','CONFIRMAR','NEGAR','PREGUNTA_GENERAL','FUERA_DE_CONTEXTO','UNKNOWN'];
    if (!valid.includes(j.intent)) j.intent = 'UNKNOWN';
    if (!Number.isInteger(j.choice)) j.choice = null;
    j.ampm_ambiguous = j.ampm_ambiguous === true;
    return j;
  } catch (e) {
    console.error('[understand] failed:', e.message);
    return { intent: 'UNKNOWN' };
  }
}

// ── Groq — solo para preguntas generales, nunca para el flujo de reservas ─────
async function askGroq(session, message, business, services) {
  // Groq solo responde preguntas informativas. Si detecta intención de reservar,
  // redirige al flujo del bot sin procesar.
  const toneMap = {
    quick:   'Tono: muy breve y directo, sin saludos largos.',
    casual:  'Tono: casual y amistoso; usa algún emoji.',
    cool:    'Tono: relajado y juvenil, con flow boricua; usa emojis.',
    premium: 'Tono: profesional y elegante; trato respetuoso.',
  };
  const tone = toneMap[business.whatsapp_bot_personality] || toneMap.quick;
  const ownerPrompt = (business.whatsapp_bot_prompt || '').trim();
  const ownerFaq    = (business.whatsapp_bot_faq    || '').trim();
  const nowPR = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const nowStrPR = `${String(nowPR.getUTCHours()).padStart(2,'0')}:${String(nowPR.getUTCMinutes()).padStart(2,'0')}`;
  const systemPrompt = `Eres el asistente de ${business.name} en ${business.city || 'Puerto Rico'}.
REGLAS ESTRICTAS:
- Responde SOLO preguntas sobre el negocio (precios, horarios, ubicación, servicios)
- Máximo 2 líneas de respuesta
- Si el cliente quiere agendar, cancelar o cambiar una cita: responde SOLO con "→CITA"
- Servicios disponibles: ${services.map(s => `${s.name} $${s.price}`).join(', ')}
- No inventes información que no esté en los datos
- Hora actual en Puerto Rico: ${nowStrPR}. Si preguntan por horarios de hoy, no menciones horas que ya pasaron.
- ${tone}${ownerPrompt ? `\n- Instrucciones del dueño: ${ownerPrompt}` : ''}${ownerFaq ? `\n- Preguntas frecuentes:\n${ownerFaq}` : ''}`;

  session.history.push({ role: 'user', content: message });
  const completion = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [{ role: 'system', content: systemPrompt }, ...session.history.slice(-4)],
    temperature: 0.2,
    max_tokens: 100
  });
  const reply = completion.choices[0].message.content.trim();

  // Si Groq detectó intención de reserva, abrir el flujo de recolección
  if (reply.startsWith('→CITA') || reply.includes('→CITA')) {
    session.history.push({ role: 'assistant', content: '[redirigido a flujo de cita]' });
    session.state = 'collecting';
    session.data.bk = {};
    return `¡Claro! 💈 Para agendar dime tu nombre, el servicio y el barbero que prefieres.`;
  }

  session.history.push({ role: 'assistant', content: reply });
  return reply;
}

// ── Reports ───────────────────────────────────────────────────────────────────
async function buildDailyReport(business, services) {
  const today = todayPR();

  const { data: appts } = await supabase
    .from('appointments')
    .select('customer_name, start_time, service_id, status')
    .eq('business_id', business.id)
    .eq('appointment_date', today)
    .neq('status', 'cancelled')
    .order('start_time', { ascending: true });

  if (!appts || appts.length === 0) return null;

  const now = new Date();
  const nowMins = (now.getUTCHours() - 4) * 60 + now.getUTCMinutes(); // PR time

  const upcoming = appts.filter(a => {
    const [h, m] = a.start_time.split(':').map(Number);
    return h * 60 + m > nowMins;
  });

  const totalRevenue = appts.reduce((sum, a) => {
    const svc = services.find(s => s.id === a.service_id);
    return sum + (svc?.price || 0);
  }, 0);

  const next = upcoming[0];
  const nextSvc = next ? services.find(s => s.id === next.service_id) : null;

  let msg = `📊 *Spacey Report — ${business.name}*\n`;
  msg += `📅 ${formatDate(today)}\n\n`;
  msg += `✂️ Citas hoy: *${appts.length}*\n`;
  msg += `💰 Ingresos estimados: *$${totalRevenue}*\n\n`;

  if (next) {
    msg += `⏭️ *Próxima:*\n`;
    msg += `• ${next.customer_name} a las ${formatTime(next.start_time)}`;
    if (nextSvc) msg += ` — ${nextSvc.name}`;
    msg += `\n`;
  }

  if (upcoming.length > 1) {
    msg += `\n📋 Restantes: *${upcoming.length - 1}*\n`;
    upcoming.slice(1, 4).forEach(a => {
      const svc = services.find(s => s.id === a.service_id);
      msg += `• ${formatTime(a.start_time)} ${a.customer_name}${svc ? ` (${svc.name})` : ''}\n`;
    });
    if (upcoming.length - 1 > 3) msg += `...y ${upcoming.length - 4} más\n`;
  }

  if (upcoming.length === 0) {
    msg += `\n✅ No quedan citas pendientes.`;
  }

  return msg;
}

async function buildClosingReport(business, services) {
  const today = todayPR();

  const { data: appts } = await supabase
    .from('appointments')
    .select('customer_name, start_time, service_id, status')
    .eq('business_id', business.id)
    .eq('appointment_date', today)
    .neq('status', 'cancelled')
    .order('start_time', { ascending: true });

  const totalRevenue = (appts || []).reduce((sum, a) => {
    const svc = services.find(s => s.id === a.service_id);
    return sum + (svc?.price || 0);
  }, 0);

  let msg = `🌙 *Cierre del día — ${business.name}*\n`;
  msg += `📅 ${formatDate(today)}\n\n`;
  msg += `✂️ Total de citas: *${appts?.length || 0}*\n`;
  msg += `💰 Ingresos del día: *$${totalRevenue}*\n\n`;
  msg += `¡Buen trabajo! Hasta mañana 💈`;

  return msg;
}

async function sendBiHourlyReports() {
  console.log('[Cron] Sending bi-hourly reports...');
  try {
    const { data: businesses } = await supabase
      .from('businesses')
      .select('*')
      .eq('is_active', true)
      .in('plan_status', ['pro', 'premium']);

    if (!businesses || businesses.length === 0) return;

    for (const business of businesses) {
      const ownerPhone = await getOwnerPhone(business);
      if (!ownerPhone) continue;

      const { data: services } = await supabase
        .from('services').select('id,name,price')
        .eq('business_id', business.id).eq('is_active', true);

      const msg = await buildDailyReport(business, services || []);
      if (!msg) continue;

      await sendWhatsApp(ownerPhone, msg);
      console.log(`[Report] Sent to ${business.name} (${ownerPhone})`);
    }
  } catch (err) {
    console.error('[Cron] Error sending bi-hourly reports:', err);
  }
}

async function sendClosingReports() {
  console.log('[Cron] Sending closing reports...');
  try {
    const { data: businesses } = await supabase
      .from('businesses')
      .select('*')
      .eq('is_active', true)
      .eq('plan_status', 'premium');

    if (!businesses || businesses.length === 0) return;

    for (const business of businesses) {
      const ownerPhone = await getOwnerPhone(business);
      if (!ownerPhone) continue;

      const { data: services } = await supabase
        .from('services').select('id,name,price')
        .eq('business_id', business.id).eq('is_active', true);

      const msg = await buildClosingReport(business, services || []);
      await sendWhatsApp(ownerPhone, msg);
      console.log(`[Report] Closing sent to ${business.name}`);
    }
  } catch (err) {
    console.error('[Cron] Error sending closing reports:', err);
  }
}

async function sendProactiveReengagement() {
  console.log('[Cron] Sending proactive re-engagement...');
  try {
    const { data: businesses } = await supabase
      .from('businesses')
      .select('*')
      .eq('is_active', true)
      .eq('plan_status', 'premium')
      .eq('whatsapp_marketing_active', true);

    if (!businesses || businesses.length === 0) return;

    for (const business of businesses) {
      const inactiveDays = business.reminder_inactive_days || 30;
      const cutoff = new Date(todayPR() + 'T12:00:00');
      cutoff.setDate(cutoff.getDate() - inactiveDays);
      const cutoffStr = cutoff.toISOString().split('T')[0];

      const { data: oldAppts } = await supabase
        .from('appointments')
        .select('customer_name, customer_phone')
        .eq('business_id', business.id)
        .lt('appointment_date', cutoffStr)
        .neq('status', 'cancelled')
        .not('customer_phone', 'is', null);

      if (!oldAppts || oldAppts.length === 0) continue;

      const seen = new Set();
      const candidates = oldAppts.filter(a => {
        if (seen.has(a.customer_phone)) return false;
        seen.add(a.customer_phone);
        return true;
      });

      for (const client of candidates) {
        const { data: recent } = await supabase
          .from('appointments')
          .select('id')
          .eq('business_id', business.id)
          .eq('customer_phone', client.customer_phone)
          .gte('appointment_date', cutoffStr)
          .limit(1);

        if (recent && recent.length > 0) continue;

        const bookingLink = bookingLinkFor(business);
        const customOffer = business.whatsapp_offer ? `\n\n${business.whatsapp_offer}` : '';
        const msg = `¡Hola ${client.customer_name}! Hace tiempo no te vemos en ${business.name} 💈${customOffer}\nEsta semana tenemos disponibilidad. ¿Quieres reservar?\n🔗 ${bookingLink}`;

        try {
          await sendWhatsApp(client.customer_phone, msg);
          console.log(`[Proactive] Sent to ${client.customer_name}`);
          await new Promise(r => setTimeout(r, 1000));
        } catch (err) {
          console.error(`[Proactive] Failed to send to ${client.customer_phone}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('[Cron] Error sending proactive messages:', err);
  }
}

// ── Recordatorios automáticos ────────────────────────────────────────────────
async function sendReminders() {
  try {
    const todayStr = todayPR();
    // mañana en PR
    const tomorrowDate = new Date(todayStr + 'T12:00:00');
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

    // ── Recordatorio 24h (citas de mañana no notificadas) ──────────────────
    // BUG 2 FIX: calcular minutos actuales en PR para filtrar por ventana 18-26h
    const nowPR24 = new Date(new Date().getTime() - 4 * 60 * 60 * 1000);
    const nowMins24 = nowPR24.getHours() * 60 + nowPR24.getMinutes();

    const { data: apt24 } = await supabase
      .from('appointments')
      .select(`
        id, customer_name, customer_phone,
        appointment_date, start_time,
        barbers(name), services(name),
        businesses(name, slug)
      `)
      .eq('appointment_date', tomorrowStr)
      .eq('status', 'confirmed')
      .eq('reminder_24h_sent', false)
      .not('customer_phone', 'is', null);

    for (const apt of apt24 || []) {
      // Solo enviar si la cita está entre 18 y 26 horas desde ahora
      const [aptH, aptM] = apt.start_time.split(':').map(Number);
      const minsUntilAppt = (24 * 60 - nowMins24) + (aptH * 60 + aptM);
      if (minsUntilAppt < 18 * 60 || minsUntilAppt > 26 * 60) continue;
      const businessName = apt.businesses?.name || 'tu barbería';
      const barberName = apt.barbers?.name || 'el barbero';
      const serviceName = apt.services?.name || 'tu servicio';
      const hora = formatTime(apt.start_time);
      const dia = formatDate(apt.appointment_date);

      const link = apt.businesses?.slug ? `${FRONTEND_URL}/book/${apt.businesses.slug}` : '';
      const tmpl24 = process.env.TWILIO_TEMPLATE_REMINDER_24H;
      // Fallback de seguridad: texto libre si aún no hay plantilla configurada.
      const msg =
        `⏰ *Recordatorio de cita — ${businessName}*\n\n` +
        `Hola ${apt.customer_name}, recuerda tu cita mañana:\n` +
        `✂️ ${serviceName} con ${barberName}\n` +
        `📅 ${dia} a las ${hora}\n\n` +
        `Responde:\n` +
        `✅ *CONFIRMO* — para confirmar tu asistencia\n` +
        `❌ *CANCELAR* — para cancelar la cita`;

      try {
        if (tmpl24) {
          await sendTemplate(apt.customer_phone, tmpl24, {
            '1': apt.customer_name, '2': serviceName, '3': barberName, '4': dia, '5': hora, '6': link,
          });
        } else {
          await sendWhatsApp(apt.customer_phone, msg);
        }
        await supabase
          .from('appointments')
          .update({ reminder_24h_sent: true })
          .eq('id', apt.id);
        console.log(`[Reminder 24h] Sent to ${apt.customer_name} (${apt.customer_phone})`);
      } catch (err) {
        console.error(`[Reminder 24h] Failed for ${apt.customer_phone}:`, err.message);
      }
      await new Promise(r => setTimeout(r, 800));
    }

    // ── Recordatorio 1h (citas de hoy dentro de ~1h no notificadas) ────────
    const nowPR = new Date(new Date().getTime() - 4 * 60 * 60 * 1000);
    const nowMins = nowPR.getHours() * 60 + nowPR.getMinutes();
    const windowStart = nowMins + 45;  // ventana 45-75 minutos desde ahora
    const windowEnd   = nowMins + 75;

    const { data: apt1h } = await supabase
      .from('appointments')
      .select(`
        id, customer_name, customer_phone,
        appointment_date, start_time,
        barbers(name), services(name), businesses(name, slug)
      `)
      .eq('appointment_date', todayStr)
      .eq('status', 'confirmed')
      .eq('reminder_30m_sent', false)
      .not('customer_phone', 'is', null);

    for (const apt of apt1h || []) {
      const [h, m] = apt.start_time.split(':').map(Number);
      const aptMins = h * 60 + m;
      if (aptMins < windowStart || aptMins > windowEnd) continue;

      const businessName = apt.businesses?.name || 'tu barbería';
      const barberName = apt.barbers?.name || 'el barbero';
      const serviceName = apt.services?.name || 'tu servicio';
      const hora = formatTime(apt.start_time);
      const link = apt.businesses?.slug ? `${FRONTEND_URL}/book/${apt.businesses.slug}` : '';
      const tmpl1h = process.env.TWILIO_TEMPLATE_REMINDER_1H;
      // Fallback de seguridad: texto libre si aún no hay plantilla configurada.
      const msg =
        `⏰ Tu cita es en aproximadamente 1 hora\n\n` +
        `💈 *${businessName}* · ${hora}\n` +
        `Con ${barberName}\n\n` +
        `¡Te esperamos!`;

      try {
        if (tmpl1h) {
          await sendTemplate(apt.customer_phone, tmpl1h, {
            '1': apt.customer_name, '2': serviceName, '3': barberName, '4': 'Hoy', '5': hora, '6': link,
          });
        } else {
          await sendWhatsApp(apt.customer_phone, msg);
        }
        await supabase
          .from('appointments')
          .update({ reminder_30m_sent: true })
          .eq('id', apt.id);
        console.log(`[Reminder 1h] Sent to ${apt.customer_name} (${apt.customer_phone})`);
      } catch (err) {
        console.error(`[Reminder 1h] Failed for ${apt.customer_phone}:`, err.message);
      }
      await new Promise(r => setTimeout(r, 800));
    }
  } catch (err) {
    console.error('[Reminders] Error:', err);
  }
}

// ── Horario de atención del bot (opt-in vía whatsapp_bot_auto_schedule) ───────
function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || '').trim());
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]);
}
function getOutOfHoursReply(business) {
  if (!business || !business.whatsapp_bot_auto_schedule) return null;
  const start = parseHM(business.whatsapp_bot_start_hour || '09:00');
  const end   = parseHM(business.whatsapp_bot_end_hour   || '18:00');
  if (start == null || end == null || start >= end) return null; // mal configurado → no bloquear
  const prNow = new Date(Date.now() - 4 * 3600 * 1000); // Puerto Rico = UTC-4 (sin DST)
  const cur = prNow.getUTCHours() * 60 + prNow.getUTCMinutes();
  if (cur >= start && cur < end) return null; // dentro de horario
  const link = bookingLinkFor(business);
  return `Gracias por escribir a *${business.name}* 🌙\n\nNuestro horario de atención es de ${business.whatsapp_bot_start_hour} a ${business.whatsapp_bot_end_hour}. Te responderemos en cuanto volvamos a abrir.\n\n¿Quieres reservar en línea? 👉 ${link}`;
}

// Evita el mensaje duplicado: durante la conversación responde SOLO el bot, así
// que borramos el job de template que el trigger encoló (created/cancelled/rescheduled).
// Las reservas web/dashboard no pasan por aquí, así que conservan su template.
async function suppressBotTemplate(appointmentId, eventType) {
  if (!appointmentId) return;
  try {
    await supabase.from('notification_jobs')
      .delete()
      .eq('appointment_id', appointmentId)
      .eq('event_type', eventType)
      .in('status', ['pending', 'processing']);
  } catch (e) {
    console.error('[suppressBotTemplate] failed:', e.message);
  }
}

async function handleMessage(phone, message, businessId) {
  const session = await getSession(phone, businessId);

  // Expiración defensiva: si la sesión en memoria está activa pero lleva más de
  // SESSION_TTL sin actualizarse (p.ej. el server se reinició y cargó del DB),
  // la reseteamos a idle antes de procesar. getSession() ya lo hace al leer del DB,
  // pero este check cierra la ventana si el objeto en-memoria quedó stale.
  if (session.state !== 'idle' && session.lastActivity && Date.now() - session.lastActivity > SESSION_TTL) {
    session.state = 'idle';
    session.data  = {};
    session.history = [];
  }

  const { business, barbers, services } = await getBusinessInfo(businessId);
  const msg = message.trim();
  const bookingLink = bookingLinkFor(business);

  // Fuera de horario: si el dueño activó el horario automático, responder y no procesar
  const offHours = getOutOfHoursReply(business);
  if (offHours) return offHours;

  // Comandos de utilidad (no son intención): reinician la conversación
  if (session.state !== 'idle' && ['reset', 'salir', 'empezar', 'inicio', 'menu'].includes(msg.toLowerCase())) {
    session.state = 'idle';
    session.data = {};
  }

  // PASO 0: identificar al cliente por su número (universal: bot / web / dashboard)
  const history = await getClientHistory(phone, businessId);

  // Contexto para Groq (REGLA #2): qué opciones se le mostraron en el turno previo.
  let offeredCtx = '';
  if ((session.state === 'picking_slot' || session.state === 'rescheduling')
      && Array.isArray(session.data?.offered) && session.data.offered.length) {
    offeredCtx = session.data.offered
      .map((o, i) => `${i + 1}) ${formatDate(o.date)} ${formatTime(o.time)}`)
      .join(', ');
  }

  // Contexto de horario del barbero en juego (Punto 1): para desambiguar AM/PM
  // y reconocer "fuera de horario". 1 query, solo en estados de flujo con barbero.
  let hoursCtx = '';
  const flowBarberId = session.data?.bk?.barberId;
  if (flowBarberId && ['collecting', 'picking_slot', 'rescheduling'].includes(session.state)) {
    const hoursMap = await getBarberHours(flowBarberId);
    const baseD = new Date(todayPR() + 'T12:00:00');
    const labels = ['hoy', 'mañana'];
    const dowAbbr = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const parts = [];
    for (let off = 0; off <= 2; off++) {
      const dd = new Date(baseD); dd.setDate(baseD.getDate() + off);
      const h = hoursMap[dd.getDay()];
      parts.push(`${labels[off] || dowAbbr[dd.getDay()]} ${h ? h.open + '–' + h.close : 'cerrado'}`);
    }
    const bn = session.data.bk.barberName || '';
    hoursCtx = `${bn ? bn + ': ' : ''}${parts.join(', ')}`;
  }

  // Groq interpreta TODO el mensaje en UNA sola llamada: intención + datos de cita
  const understood = await understand(msg, services, barbers, session.state, offeredCtx, hoursCtx);

  // El motor (booking-logic.js) decide la respuesta y muta la sesión.
  // Toda la I/O entra por `deps` para mantener el motor testeable.
  return await bookingLogic.respond({
    session,
    msg,
    understood,
    ctx: { business, services, barbers, bookingLink, history, phone },
    deps: {
      getSlots: getAvailableSlots,
      getDayAvailability,
      checkSlot,
      getUpcoming,
      getActiveAppointments: () => getAllActiveAppointments(phone, businessId),
      commitCreate: async (bk) => {
        const { appt, error } = await createAppointment({
          businessId, barberId: bk.barberId, serviceId: bk.serviceId,
          customerName: bk.name, customerPhone: phone,
          date: bk.date, startTime: bk.startTime, endTime: bk.endTime,
        });
        if (error || !appt) {
          console.error('[commitCreate]', error?.code, error?.message);
          // 23505 = unique_violation: el índice único de la DB rechazó el slot
          // porque otro cliente lo tomó entre que se lo mostramos y confirmó
          // (carrera real, backstop irrompible). Lo distinguimos del error genérico
          // para re-ofrecer horarios en vez de decir "no pude guardar".
          if (error && error.code === '23505') return { ok: false, reason: 'taken' };
          return { ok: false };
        }
        await suppressBotTemplate(appt.id, 'created'); // el bot ya confirmó aquí
        return { ok: true };
      },
      commitReschedule: async (apptId, date, time, endTime) => {
        const { error } = await supabase.from('appointments')
          .update({
            appointment_date:   date,
            start_time:        time,
            end_time:          endTime,
            // Reset so reminders fire for the NEW time, not the old one
            reminder_24h_sent: false,
            reminder_30m_sent: false,
          })
          .eq('id', apptId);
        if (error) {
          console.error('[commitReschedule]', error.code, error.message);
          // Solo es "slot tomado" si la violación viene del índice de citas (uniq_appointment_slot).
          // Un 23505 de notification_jobs (trigger interno) NO significa que el slot esté ocupado.
          if (error.code === '23505' && error.message?.includes('uniq_appointment_slot')) {
            return { ok: false, reason: 'taken' };
          }
          return { ok: false };
        }
        await suppressBotTemplate(apptId, 'rescheduled');
        return { ok: true };
      },
      commitCancel: async (apptId) => {
        const { error } = await supabase.from('appointments')
          .update({ status: 'cancelled' }).eq('id', apptId);
        if (error) { console.error('[commitCancel]', error.message); return { ok: false }; }
        await suppressBotTemplate(apptId, 'cancelled');
        return { ok: true };
      },
      // Fallback sin Groq: respuesta informativa neutral (lista de servicios).
      // SIN CTA de reserva — el motor (CASO A/C) añade su propio cierre, así que
      // no debe pedir "dime tu nombre para agendar" a quien ya tiene cita.
      askGeneral: (m) => canUseGroq(business)
        ? askGroq(session, m, business, services)
        : Promise.resolve(`Soy el asistente de ${business.name} 💈\n\n✂️ *Servicios:*\n${services.map(s => `• ${s.name} — $${s.price}`).join('\n')}`),
    },
  });
}


// ── Rate limiter: 10 msgs / minuto (burst) + 30 msgs / hora (sostenido) ───────
const rateLimitMap = new Map(); // phone → { minCount, minStart, hourCount, hourStart, warned }
const RATE_LIMIT_MIN = 10;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_HOUR = 30;
const HOUR_WINDOW_MS = 60 * 60 * 1000;

// Returns 'ok' (procesar), 'warn' (avisar una vez y cortar) o 'silent' (cortar sin avisar)
function checkRateLimit(phone) {
  const now = Date.now();
  let e = rateLimitMap.get(phone);
  if (!e) { e = { minCount: 0, minStart: now, hourCount: 0, hourStart: now, warned: false }; rateLimitMap.set(phone, e); }
  if (now - e.minStart > RATE_WINDOW_MS) { e.minCount = 0; e.minStart = now; }
  if (now - e.hourStart > HOUR_WINDOW_MS) { e.hourCount = 0; e.hourStart = now; e.warned = false; }
  e.minCount++; e.hourCount++;
  const over = e.minCount > RATE_LIMIT_MIN || e.hourCount > RATE_LIMIT_HOUR;
  if (!over) return 'ok';
  if (!e.warned) {
    e.warned = true;
    console.warn(`[RATE_LIMIT] ${phone} — min=${e.minCount} hour=${e.hourCount}`);
    return 'warn';
  }
  return 'silent';
}

// Clean up stale entries every 5 minutes (once the hour window has fully elapsed)
setInterval(() => {
  const now = Date.now();
  for (const [phone, e] of rateLimitMap.entries()) {
    if (now - e.hourStart > HOUR_WINDOW_MS) rateLimitMap.delete(phone);
  }
}, 5 * 60 * 1000);

// ── Serialización por teléfono (candado en memoria) ───────────────────────────
// Dos mensajes casi simultáneos del MISMO número corrían en paralelo: como la
// sesión es un objeto compartido y `state` solo cambia tras los await, dos "sí"
// rápidos podían crear 2 citas / corromper el estado. Encadenamos el ciclo
// read-modify-write por teléfono para que se procesen en serie (orden de llegada).
// Alcance: 1 proceso (deploy actual = instancia única). Entre instancias el
// backstop sigue siendo el índice único de la DB (uniq_appointment_slot).
const phoneLocks = new Map(); // phone → última promesa en la cola
function withPhoneLock(phone, fn) {
  const prev = phoneLocks.get(phone) || Promise.resolve();
  const run = prev.then(fn, fn); // corre fn pase lo que pase con el anterior
  const tail = run.catch(() => {}); // cola que nunca rechaza (para encadenar)
  phoneLocks.set(phone, tail);
  tail.finally(() => { if (phoneLocks.get(phone) === tail) phoneLocks.delete(phone); });
  return run; // el caller ve el resultado/rechazo real de SU fn
}

// ── Contador de uso de mensajes por negocio (solo medición) ───────────────────
async function bumpUsage(businessId, direction, n = 1) {
  if (!businessId) return;
  try {
    await supabase.rpc('increment_message_usage', { p_business_id: businessId, p_direction: direction, p_count: n });
  } catch (e) {
    console.error('[USAGE] increment failed:', e.message);
  }
}

// ── Twilio signature validator middleware ─────────────────────────────────────
async function validateTwilioSignature(req, res, next) {
  // Skip validation in local dev if flag is set
  if (process.env.SKIP_TWILIO_VALIDATION === 'true') {
    console.warn('[WARN] Twilio signature validation SKIPPED (dev mode)');
    return next();
  }

  const signature = req.headers['x-twilio-signature'];
  const url = process.env.WEBHOOK_URL;

  if (!signature) {
    console.warn('[SECURITY] Missing X-Twilio-Signature header — rejected');
    return res.status(403).send('Forbidden');
  }

  // Try platform token first (covers sandbox + businesses without own Twilio account)
  if (twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body)) {
    return next();
  }

  // Try per-business auth token for businesses with their own Twilio sub-account
  const To = req.body?.To;
  if (To) {
    const { data: ts } = await supabase
      .from('twilio_settings')
      .select('auth_token')
      .eq('whatsapp_from', To)
      .eq('is_active', true)
      .maybeSingle();
    if (ts?.auth_token && twilio.validateRequest(ts.auth_token, signature, url, req.body)) {
      return next();
    }
  }

  console.warn(`[SECURITY] Invalid Twilio signature from ${req.ip} — rejected`);
  return res.status(403).send('Forbidden');
}

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post('/webhook', validateTwilioSignature, async (req, res) => {
  const { Body, From, To } = req.body;
  if (!Body || !From || !To) return res.status(400).end();

  const phone = From.replace('whatsapp:', '');

  // Respond 200 immediately so Twilio doesn't retry
  res.status(200).end();

  // Rate limit check (no llama a Groq ni a la DB si excede)
  const rl = checkRateLimit(phone);
  if (rl !== 'ok') {
    if (rl === 'warn') await sendWhatsApp(phone, 'Has enviado demasiados mensajes. Intenta de nuevo más tarde. 🙏');
    return;
  }

  console.log(`[${phone}] ${Body}`);

  try {
    // Route by the receiving Twilio number so each business gets only its messages.
    const { data: twilioSettings, error } = await supabase
      .from('twilio_settings').select('business_id, account_sid, auth_token, whatsapp_from')
      .eq('whatsapp_from', To)
      .eq('is_active', true)
      .maybeSingle();

    if (error || !twilioSettings) {
      console.warn(`[routing] No active twilio_settings for To=${To}`);
      await sendWhatsApp(phone, 'Servicio no disponible en este momento.');
      return;
    }

    // Build a per-business Twilio client if the business has its own credentials;
    // otherwise fall back to the platform client.
    const bizClient = (twilioSettings.account_sid && twilioSettings.auth_token)
      ? twilio(twilioSettings.account_sid, twilioSettings.auth_token)
      : twilioClient;
    const bizFrom = twilioSettings.whatsapp_from || process.env.TWILIO_WHATSAPP_FROM;

    // Serializado por teléfono: el ciclo leer-sesión → procesar → guardar →
    // responder corre en serie para este número (evita carreras y citas dobles).
    await withPhoneLock(phone, async () => {
      const bId = twilioSettings.business_id;
      const reply = await handleMessage(phone, Body, bId);
      // Persist session after every message (write-through). La sesión se llave
      // por (business_id, phone) — usar la MISMA clave para guardar (FIX 3).
      const key = sessKey(phone, bId);
      if (sessions[key]) await saveSession(phone, sessions[key], bId);
      await sendWhatsApp(phone, reply, bizClient, bizFrom);
      // Medición de uso: 1 entrante procesado + 1 respuesta enviada
      await bumpUsage(bId, 'inbound', 1);
      await bumpUsage(bId, 'outbound', 1);
    });
  } catch (err) {
    console.error('Webhook error:', err);
    await sendWhatsApp(phone, 'Ocurrió un error. Intenta de nuevo.');
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', version: '4.5.0-reschedule-day-fix' }));

app.post('/admin/report', async (req, res) => {
  const { type = 'bihourly' } = req.body;
  try {
    if (type === 'closing') await sendClosingReports();
    else if (type === 'reminders') await sendReminders();
    else await sendBiHourlyReports();
    res.json({ status: 'ok', type });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cron jobs ─────────────────────────────────────────────────────────────────
// Cada 2 horas 8am-6pm PR (PR = UTC-4, por eso +4 en UTC)
cron.schedule('0 12,14,16,18,20,22 * * *', () => sendBiHourlyReports());

// Reporte de cierre 8pm PR = medianoche UTC
cron.schedule('0 0 * * *', () => sendClosingReports());

// Re-engagement semanal lunes 9am PR = lunes 1pm UTC
cron.schedule('0 13 * * 1', () => sendProactiveReengagement());

// Recordatorios 24h y 1h — cada 30 minutos
cron.schedule('*/30 * * * *', () => sendReminders());

console.log('✅ Cron jobs registered');

// ── Server ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log('✅ BarberBot v4.5.0-reschedule-day-fix started');
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('❌ Server error:', err);
  process.exit(1);
});
