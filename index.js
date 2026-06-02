// Polyfill WebSocket for Node.js < 22 (required by Supabase realtime)
if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const Groq = require('groq-sdk');
const cron = require('node-cron');

// ── Environment validation ───────────────────────────────────────────────────
const requiredEnvVars = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM',
  'GROQ_API_KEY'
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

// ── Session store ─────────────────────────────────────────────────────────────
const sessions = {};
const SESSION_TTL = 30 * 60 * 1000;

function getSession(phone) {
  const now = Date.now();
  if (sessions[phone] && now - sessions[phone].lastActivity > SESSION_TTL) {
    delete sessions[phone];
  }
  if (!sessions[phone]) {
    sessions[phone] = { state: 'idle', data: {}, history: [], lastActivity: now };
  }
  sessions[phone].lastActivity = now;
  return sessions[phone];
}

// ── Date helpers ──────────────────────────────────────────────────────────────
// Puerto Rico is UTC-4 year-round (no DST)
function todayPR() {
  const now = new Date();
  const prTime = new Date(now.getTime() - 4 * 60 * 60 * 1000);
  return prTime.toISOString().split('T')[0];
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

function canSendProactive(business) {
  return getPlan(business) === 'premium';
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function getBusinessInfo(businessId) {
  const { data: business } = await supabase
    .from('businesses').select('*').eq('id', businessId).single();
  const { data: barbers } = await supabase
    .from('barbers').select('id,name,phone_e164')
    .eq('business_id', businessId).eq('is_active', true);
  const { data: services } = await supabase
    .from('services').select('id,name,duration_minutes,price')
    .eq('business_id', businessId).eq('is_active', true);
  return { business, barbers, services };
}

async function getOwnerPhone(business) {
  if (!business?.owner_id) return null;
  const { data: profile } = await supabase
    .from('profiles').select('phone').eq('id', business.owner_id).maybeSingle();
  return profile?.phone || null;
}

async function getAvailableSlots(barberId, date) {
  const dow = new Date(date + 'T12:00:00').getDay();
  const { data: schedule } = await supabase
    .from('schedules').select('start_time,end_time')
    .eq('barber_id', barberId).eq('day_of_week', dow).eq('is_active', true)
    .maybeSingle();
  if (!schedule) return [];

  const { data: appointments } = await supabase
    .from('appointments').select('start_time,end_time')
    .eq('barber_id', barberId).eq('appointment_date', date).neq('status', 'cancelled');

  const slots = [];
  let [sh, sm] = schedule.start_time.split(':').map(Number);
  const [eh, em] = schedule.end_time.split(':').map(Number);
  const endMins = eh * 60 + em;
  while (sh * 60 + sm + 30 <= endMins) {
    const slotStart = `${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`;
    if (!appointments?.some(a => a.start_time.slice(0,5) === slotStart)) {
      slots.push(slotStart);
    }
    sm += 30;
    if (sm >= 60) { sh++; sm -= 60; }
  }
  return slots;
}

async function getNextAvailableDays(barberId, count = 5) {
  const results = [];
  const todayStr = todayPR(); // Use PR local date, not UTC
  const today = new Date(todayStr + 'T12:00:00');
  let offset = 1;
  while (results.length < count && offset <= 30) {
    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    const dateStr = d.toISOString().split('T')[0];
    const slots = await getAvailableSlots(barberId, dateStr);
    if (slots.length > 0) results.push({ date: dateStr });
    offset++;
  }
  return results;
}

// Normaliza teléfono a solo dígitos para comparar
function normalizePhone(phone) {
  return phone.replace(/\D/g, '');
}

// Busca si el teléfono corresponde a un usuario registrado en Spacey
async function findRegisteredUser(phone) {
  const normalized = normalizePhone(phone);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, full_name, phone')
    .not('phone', 'is', null);

  if (!profiles) return null;
  return profiles.find(p => normalizePhone(p.phone || '') === normalized) || null;
}

async function createAppointment(data) {
  // Intentar linkear con usuario registrado por teléfono
  const registeredUser = await findRegisteredUser(data.customerPhone);

  const payload = {
    business_id: data.businessId,
    barber_id: data.barberId,
    service_id: data.serviceId,
    customer_name: data.customerName,
    customer_phone: data.customerPhone,
    appointment_date: data.date,
    start_time: data.startTime,
    end_time: data.endTime,
    status: 'confirmed',
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

async function getActiveAppointment(phone, businessId) {
  const todayStr = todayPR();
  const { data } = await supabase
    .from('appointments')
    .select('id, customer_name, appointment_date, start_time, barber_id, service_id')
    .eq('business_id', businessId)
    .eq('customer_phone', phone)
    .eq('status', 'confirmed')
    .gte('appointment_date', todayStr)
    .order('appointment_date', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data;
}

async function sendWhatsApp(to, body) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: `whatsapp:${to}`,
    body
  });
}

// ── Groq — solo para preguntas generales, nunca para el flujo de reservas ─────
async function askGroq(session, message, business, services) {
  // Groq solo responde preguntas informativas. Si detecta intención de reservar,
  // redirige al flujo del bot sin procesar.
  const systemPrompt = `Eres el asistente de ${business.name} en ${business.city || 'Puerto Rico'}.
REGLAS ESTRICTAS:
- Responde SOLO preguntas sobre el negocio (precios, horarios, ubicación, servicios)
- Máximo 2 líneas de respuesta
- Si el cliente quiere agendar, cancelar o cambiar una cita: responde SOLO con "→CITA"
- Servicios disponibles: ${services.map(s => `${s.name} $${s.price}`).join(', ')}
- No inventes información que no esté en los datos`;

  session.history.push({ role: 'user', content: message });
  const completion = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [{ role: 'system', content: systemPrompt }, ...session.history.slice(-4)],
    temperature: 0.2,
    max_tokens: 100
  });
  const reply = completion.choices[0].message.content.trim();

  // Si Groq detectó intención de reserva, redirigir al flujo nativo
  if (reply.startsWith('→CITA') || reply.includes('→CITA')) {
    session.history.push({ role: 'assistant', content: '[redirigido a flujo de cita]' });
    session.state = 'name';
    return `¡Claro! 💈 Para agendar tu cita, ¿cuál es tu nombre?`;
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

        const bookingLink = business.whatsapp_booking_link || `https://spaceyreserve.netlify.app/book/${business.slug}`;
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

// ── State machine ─────────────────────────────────────────────────────────────
const GREETINGS = new Set([
  'hola','hi','hello','buenas','hey','ola',
  'buenos dias','buen dia','buenas tardes','buenas noches',
  'info','información','informacion'
]);

// Palabras específicas de booking — "quiero" eliminado por ser demasiado genérico
const BOOKING_WORDS = ['cita','reservar','agendar','turno','reserva','book','nueva cita','hacer cita'];

// Palabras de reagendar — se chequean ANTES que BOOKING_WORDS
const REAGENDAR_WORDS = ['reagendar','cambiar cita','cambiar mi cita','mover cita','reprogramar','reschedule','cambio de cita'];

// Palabras de cancelar cita real (no solo resetear sesión)
const CANCELAR_CITA_WORDS = ['cancelar mi cita','quiero cancelar','borrar mi cita'];

// Solo resetea el flujo del bot, no cancela citas en DB
const RESET_FLOW_WORDS = ['cancelar','salir','exit','reset','empezar','inicio'];

async function handleMessage(phone, message, businessId) {
  const session = getSession(phone);
  const { business, barbers, services } = await getBusinessInfo(businessId);
  const msg = message.trim();
  const msgLower = msg.toLowerCase();
  const bookingLink = business.whatsapp_booking_link || `https://spaceyreserve.netlify.app/book/${business.slug || 'annlobarberia'}`;

  // ── Reset de flujo (solo cuando está en medio de un proceso) ──────────────
  if (session.state !== 'idle' &&
      RESET_FLOW_WORDS.some(w => msgLower === w)) {
    session.state = 'idle';
    session.data = {};
    return `Proceso cancelado. Escribe *"hola"* para comenzar de nuevo 👋`;
  }

  // ── IDLE ──────────────────────────────────────────────────────────────────
  if (session.state === 'idle') {

    // Saludo
    if (GREETINGS.has(msgLower)) {
      const svcList = services.map(s => `• ${s.name}: $${s.price}`).join('\n');
      return `¡Hola! Soy el asistente de *${business.name}* 💈\n\n*Servicios:*\n${svcList}\n\nEscribe *"cita"* para agendar 📅 o *"cambiar mi cita"* para reagendar.`;
    }

    // Reagendar — chequeado ANTES que booking para evitar confusión
    if (REAGENDAR_WORDS.some(w => msgLower.includes(w))) {
      const existing = await getActiveAppointment(phone, businessId);
      if (!existing) {
        return `No encontré una cita activa para tu número. ¿Quieres *agendar* una nueva? Escribe *"cita"*.`;
      }
      // Buscar barber y service para mostrar el resumen
      const barber = barbers.find(b => b.id === existing.barber_id);
      const service = services.find(s => s.id === existing.service_id);
      session.state = 'reagendar_confirm';
      session.data.existingAppointmentId = existing.id;
      session.data.existingBarberId = existing.barber_id;
      session.data.existingServiceId = existing.service_id;
      session.data.customerName = existing.customer_name;
      return `📅 Tu cita actual:\n\n✂️ ${service?.name || 'Servicio'}\n💈 ${barber?.name || 'Barbero'}\n🗓 ${formatDate(existing.appointment_date)} a las ${formatTime(existing.start_time)}\n\n¿Quieres cambiarla?\n1. Sí, reagendar\n2. No, mantenerla`;
    }

    // Cancelar cita real
    if (CANCELAR_CITA_WORDS.some(w => msgLower.includes(w))) {
      const existing = await getActiveAppointment(phone, businessId);
      if (!existing) {
        return `No encontré una cita activa para tu número.`;
      }
      const barber = barbers.find(b => b.id === existing.barber_id);
      const service = services.find(s => s.id === existing.service_id);
      session.state = 'cancel_confirm';
      session.data.existingAppointmentId = existing.id;
      session.data.customerName = existing.customer_name;
      return `⚠️ ¿Seguro que quieres cancelar?\n\n✂️ ${service?.name || 'Servicio'}\n💈 ${barber?.name || 'Barbero'}\n🗓 ${formatDate(existing.appointment_date)} a las ${formatTime(existing.start_time)}\n\n1. Sí, cancelar\n2. No, mantenerla`;
    }

    // Iniciar booking
    if (BOOKING_WORDS.some(w => msgLower.includes(w))) {
      session.state = 'name';
      return `¡Perfecto! 💈 ¿Cuál es tu nombre?`;
    }

    // Pro/Premium: Groq para preguntas generales
    if (canUseGroq(business)) {
      return askGroq(session, msg, business, services);
    }

    // Basic/Trial: respuesta genérica
    const svcList = services.map(s => `• ${s.name}: $${s.price}`).join('\n');
    return `¡Hola! Soy el asistente de *${business.name}* 💈\n\n*Servicios:*\n${svcList}\n\nEscribe *"cita"* para agendar o visita:\n${bookingLink}`;
  }

  // ── REAGENDAR CONFIRM ─────────────────────────────────────────────────────
  if (session.state === 'reagendar_confirm') {
    if (msg === '1' || msgLower.includes('sí') || msgLower === 'si' || msgLower === 'dale') {
      // Obtener fechas disponibles para el mismo barbero y servicio
      const service = services.find(s => s.id === session.data.existingServiceId);
      const days = await getNextAvailableDays(session.data.existingBarberId, 5);
      if (days.length === 0) {
        session.state = 'idle';
        session.data = {};
        return `No hay fechas disponibles en los próximos 30 días para reagendar. Contáctanos directamente.`;
      }
      session.data.availableDays = days;
      const list = days.map((d, i) => `${i+1}. ${formatDate(d.date)}`).join('\n');
      session.state = 'reagendar_date';
      return `*${service?.name || 'Servicio'}* ✓\n\nElige la nueva fecha:\n${list}`;
    } else if (msg === '2' || msgLower === 'no') {
      session.state = 'idle';
      session.data = {};
      return `¡Perfecto! Tu cita se mantiene igual. ¡Te esperamos! 💈`;
    } else {
      return `Responde *1* para reagendar o *2* para mantener tu cita.`;
    }
  }

  // ── REAGENDAR DATE ────────────────────────────────────────────────────────
  if (session.state === 'reagendar_date') {
    const num = parseInt(msg) - 1;
    const days = session.data.availableDays;
    if (isNaN(num) || num < 0 || num >= days.length) {
      const list = days.map((d, i) => `${i+1}. ${formatDate(d.date)}`).join('\n');
      return `Elige un número:\n${list}`;
    }
    session.data.selectedDate = days[num].date;
    const slots = await getAvailableSlots(session.data.existingBarberId, session.data.selectedDate);
    if (slots.length === 0) {
      const list = days.map((d, i) => `${i+1}. ${formatDate(d.date)}`).join('\n');
      return `Sin horarios para esa fecha. Elige otra:\n${list}`;
    }
    session.data.availableSlots = slots;
    const list = slots.map((s, i) => `${i+1}. ${formatTime(s)}`).join('\n');
    session.state = 'reagendar_slot';
    return `*${formatDate(session.data.selectedDate)}* ✓\n\nHorarios disponibles:\n${list}`;
  }

  // ── REAGENDAR SLOT ────────────────────────────────────────────────────────
  if (session.state === 'reagendar_slot') {
    const num = parseInt(msg) - 1;
    const slots = session.data.availableSlots;
    if (isNaN(num) || num < 0 || num >= slots.length) {
      const list = slots.map((s, i) => `${i+1}. ${formatTime(s)}`).join('\n');
      return `Elige un número:\n${list}`;
    }

    const startTime = slots[num];
    const service = services.find(s => s.id === session.data.existingServiceId);
    const barber = barbers.find(b => b.id === session.data.existingBarberId);
    const [h, m] = startTime.split(':').map(Number);
    const endMin = h * 60 + m + (service?.duration_minutes || 30);
    const endTime = `${String(Math.floor(endMin/60)).padStart(2,'0')}:${String(endMin%60).padStart(2,'0')}`;

    // Save data before clearing session
    const customerName = session.data.customerName || 'cliente';
    const newDate = session.data.selectedDate;
    const apptId = session.data.existingAppointmentId;

    const { error } = await supabase
      .from('appointments')
      .update({
        appointment_date: newDate,
        start_time: startTime,
        end_time: endTime,
      })
      .eq('id', apptId);

    session.state = 'idle';
    session.data = {};

    if (error) {
      console.error('Reagendar error:', error);
      return `Error al reagendar. Intenta de nuevo o escribe *"cita"* para una nueva.`;
    }

    return `✅ *¡Cita reagendada, ${customerName}!*\n\n✂️ ${service?.name || 'Servicio'}\n💈 ${barber?.name || 'Barbero'}\n📅 ${formatDate(newDate)} a las ${formatTime(startTime)}\n\n¡Te esperamos! 💈`;
  }

  // ── CANCEL CONFIRM ────────────────────────────────────────────────────────
  if (session.state === 'cancel_confirm') {
    if (msg === '1' || msgLower.includes('sí') || msgLower === 'si') {
      const { error } = await supabase
        .from('appointments')
        .update({ status: 'cancelled' })
        .eq('id', session.data.existingAppointmentId);

      session.state = 'idle';
      const name = session.data.customerName;
      session.data = {};

      if (error) {
        return `Error al cancelar. Contáctanos directamente.`;
      }
      return `Cita cancelada, ${name}. Si cambias de opinión escribe *"cita"* para agendar de nuevo. ¡Hasta pronto! 👋`;
    } else {
      session.state = 'idle';
      session.data = {};
      return `¡Perfecto! Tu cita se mantiene. ¡Te esperamos! 💈`;
    }
  }

  // ── NAME ──────────────────────────────────────────────────────────────────
  if (session.state === 'name') {
    if (msg.length < 2) return `Por favor dime tu nombre.`;
    session.data.customerName = msg;
    const list = services.map((s, i) => `${i+1}. ${s.name} — $${s.price} (${s.duration_minutes} min)`).join('\n');
    session.state = 'service';
    return `¡Hola, ${session.data.customerName}! 👋\n\n¿Qué servicio deseas?\n${list}`;
  }

  // ── SERVICE ───────────────────────────────────────────────────────────────
  if (session.state === 'service') {
    const num = parseInt(msg) - 1;
    if (isNaN(num) || num < 0 || num >= services.length) {
      const list = services.map((s, i) => `${i+1}. ${s.name} — $${s.price}`).join('\n');
      return `Elige un número del 1 al ${services.length}:\n${list}`;
    }
    session.data.service = services[num];
    const list = barbers.map((b, i) => `${i+1}. ${b.name}`).join('\n');
    session.state = 'barber';
    return `*${session.data.service.name}* ✓\n\n¿Con quién prefieres?\n${list}\n${barbers.length + 1}. Cualquiera disponible`;
  }

  // ── BARBER ────────────────────────────────────────────────────────────────
  if (session.state === 'barber') {
    const num = parseInt(msg) - 1;
    if (isNaN(num) || num < 0 || num > barbers.length) {
      const list = barbers.map((b, i) => `${i+1}. ${b.name}`).join('\n');
      return `Elige un número:\n${list}\n${barbers.length + 1}. Cualquiera disponible`;
    }
    const selectedBarber = num === barbers.length ? barbers[0] : barbers[num];
    session.data.barberId = selectedBarber.id;
    session.data.barberName = selectedBarber.name;

    const days = await getNextAvailableDays(session.data.barberId, 5);
    if (days.length === 0) {
      session.state = 'idle';
      return `No hay fechas disponibles en los próximos 30 días. Contáctanos directamente.`;
    }
    session.data.availableDays = days;
    const list = days.map((d, i) => `${i+1}. ${formatDate(d.date)}`).join('\n');
    session.state = 'date';
    return `*${session.data.barberName}* ✓\n\nFechas disponibles:\n${list}`;
  }

  // ── DATE ──────────────────────────────────────────────────────────────────
  if (session.state === 'date') {
    const num = parseInt(msg) - 1;
    const days = session.data.availableDays;
    if (isNaN(num) || num < 0 || num >= days.length) {
      const list = days.map((d, i) => `${i+1}. ${formatDate(d.date)}`).join('\n');
      return `Elige un número:\n${list}`;
    }
    session.data.selectedDate = days[num].date;
    const slots = await getAvailableSlots(session.data.barberId, session.data.selectedDate);
    if (slots.length === 0) {
      const list = days.map((d, i) => `${i+1}. ${formatDate(d.date)}`).join('\n');
      return `Sin horarios para esa fecha. Elige otra:\n${list}`;
    }
    session.data.availableSlots = slots;
    const list = slots.map((s, i) => `${i+1}. ${formatTime(s)}`).join('\n');
    session.state = 'slot';
    return `*${formatDate(session.data.selectedDate)}* ✓\n\nHorarios disponibles:\n${list}`;
  }

  // ── SLOT ──────────────────────────────────────────────────────────────────
  if (session.state === 'slot') {
    const num = parseInt(msg) - 1;
    const slots = session.data.availableSlots;
    if (isNaN(num) || num < 0 || num >= slots.length) {
      const list = slots.map((s, i) => `${i+1}. ${formatTime(s)}`).join('\n');
      return `Elige un número:\n${list}`;
    }

    const startTime = slots[num];
    const service = session.data.service;
    const [h, m] = startTime.split(':').map(Number);
    const endMin = h * 60 + m + (service.duration_minutes || 30);
    const endTime = `${String(Math.floor(endMin/60)).padStart(2,'0')}:${String(endMin%60).padStart(2,'0')}`;

    const { error, isGuest } = await createAppointment({
      businessId,
      barberId: session.data.barberId,
      serviceId: service.id,
      customerName: session.data.customerName,
      customerPhone: phone,
      date: session.data.selectedDate,
      startTime,
      endTime
    });

    if (error) {
      console.error('Appointment error:', error);
      return `Error al crear la cita. Por favor intenta de nuevo.`;
    }

    const customerName = session.data.customerName;
    sessions[phone] = { state: 'idle', data: {}, history: [], lastActivity: Date.now() };

    const barber = barbers.find(b => b.id === session.data.barberId);
    const confirmMsg = `✅ *¡Cita confirmada, ${customerName}!*\n\n✂️ ${service.name}\n💈 ${barber?.name}\n📅 ${formatDate(session.data.selectedDate)} a las ${formatTime(startTime)}\n\n_Responde "cambiar mi cita" si necesitas reagendar_\n\n🔗 ${bookingLink}`;

    // Para invitados: enviar mensaje de conversión 3 segundos después
    if (isGuest) {
      const encodedPhone = encodeURIComponent(phone);
      const registerLink = `https://spaceyreserve.netlify.app/register?phone=${encodedPhone}`;
      setTimeout(async () => {
        try {
          await sendWhatsApp(phone,
            `💡 *¿Sabías que puedes crear una cuenta gratis?*\n\nCon tu cuenta en Spacey Reserve puedes:\n✅ Ver el historial de tus citas\n✅ Reagendar desde la web\n✅ Recibir ofertas exclusivas\n✅ Acumular visitas y ser VIP\n\n🔗 ${registerLink}`
          );
        } catch (err) {
          console.error('[Conversion] Error sending guest conversion message:', err.message);
        }
      }, 4000);
    }

    return confirmMsg;
  }

  // Fallback
  session.state = 'idle';
  return `Escribe *"hola"* para ver servicios, *"cita"* para agendar, o *"cambiar mi cita"* para reagendar.`;
}

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const { Body, From } = req.body;
  const phone = From.replace('whatsapp:', '');

  res.status(200).end();

  console.log(`[${phone}] ${Body}`);

  try {
    const { data: twilioSettings, error } = await supabase
      .from('twilio_settings').select('business_id')
      .eq('is_active', true).limit(1).maybeSingle();

    if (error || !twilioSettings) {
      await sendWhatsApp(phone, 'Servicio no disponible en este momento.');
      return;
    }

    const reply = await handleMessage(phone, Body, twilioSettings.business_id);
    await sendWhatsApp(phone, reply);
  } catch (err) {
    console.error('Webhook error:', err);
    await sendWhatsApp(phone, 'Ocurrió un error. Intenta de nuevo.');
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.1.0' }));

app.post('/admin/report', async (req, res) => {
  const { type = 'bihourly' } = req.body;
  try {
    if (type === 'closing') await sendClosingReports();
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

console.log('✅ Cron jobs registered');

// ── Server ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log('✅ BarberBot v2.1.0 started');
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('❌ Server error:', err);
  process.exit(1);
});
