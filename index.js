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
const sessions = {}; // in-memory cache: phone → session
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

async function getSession(phone) {
  const now = Date.now();

  // 1. Check warm cache
  if (sessions[phone]) {
    if (now - sessions[phone].lastActivity > SESSION_TTL) {
      delete sessions[phone]; // expired in cache
    } else {
      sessions[phone].lastActivity = now;
      return sessions[phone];
    }
  }

  // 2. Load from Supabase
  try {
    const { data } = await supabase
      .from('bot_sessions')
      .select('state, data, history, updated_at')
      .eq('phone', phone)
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
        sessions[phone] = session;
        return session;
      }
    }
  } catch (err) {
    console.error('[Session] DB load error, using fresh session:', err.message);
  }

  // 3. New / expired session
  const fresh = { state: 'idle', data: {}, history: [], lastActivity: now };
  sessions[phone] = fresh;
  return fresh;
}

async function saveSession(phone, session) {
  session.lastActivity = Date.now();
  sessions[phone] = session; // keep cache warm

  try {
    await supabase
      .from('bot_sessions')
      .upsert({
        phone,
        state: session.state,
        data: session.data,
        history: session.history || [],
        updated_at: new Date().toISOString(),
      }, { onConflict: 'phone' });
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

async function getClientHistory(phone, businessId) {
  const todayStr = todayPR();
  const { data } = await supabase
    .from('appointments')
    .select('id, customer_name, appointment_date, start_time, barber_id, service_id, status, barbers(name), services(name)')
    .eq('business_id', businessId)
    .eq('customer_phone', phone)
    .order('appointment_date', { ascending: false })
    .limit(20);

  if (!data || !data.length) return { hasHistory: false };

  const name = data.find(a => a.customer_name)?.customer_name || null;
  const active = data
    .filter(a => a.status === 'confirmed' && a.appointment_date >= todayStr)
    .sort((a, b) => (a.appointment_date < b.appointment_date ? -1 : 1))[0] || null;
  const lastPast = data.find(a => a.appointment_date < todayStr && a.status !== 'cancelled') || null;

  return {
    hasHistory: true,
    name,
    activeAppointment: active,
    lastService: lastPast ? { id: lastPast.service_id, name: lastPast.services?.name } : null,
    lastBarber: lastPast ? { id: lastPast.barber_id, name: lastPast.barbers?.name } : null,
  };
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
  const toneMap = {
    quick:   'Tono: muy breve y directo, sin saludos largos.',
    casual:  'Tono: casual y amistoso; usa algún emoji.',
    cool:    'Tono: relajado y juvenil, con flow boricua; usa emojis.',
    premium: 'Tono: profesional y elegante; trato respetuoso.',
  };
  const tone = toneMap[business.whatsapp_bot_personality] || toneMap.quick;
  const ownerPrompt = (business.whatsapp_bot_prompt || '').trim();
  const systemPrompt = `Eres el asistente de ${business.name} en ${business.city || 'Puerto Rico'}.
REGLAS ESTRICTAS:
- Responde SOLO preguntas sobre el negocio (precios, horarios, ubicación, servicios)
- Máximo 2 líneas de respuesta
- Si el cliente quiere agendar, cancelar o cambiar una cita: responde SOLO con "→CITA"
- Servicios disponibles: ${services.map(s => `${s.name} $${s.price}`).join(', ')}
- No inventes información que no esté en los datos
- ${tone}${ownerPrompt ? `\n- Instrucciones del dueño: ${ownerPrompt}` : ''}`;

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

// ── Recordatorios automáticos ────────────────────────────────────────────────
async function sendReminders() {
  try {
    const todayStr = todayPR();
    // mañana en PR
    const tomorrowDate = new Date(todayStr + 'T12:00:00');
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

    // ── Recordatorio 24h (citas de mañana no notificadas) ──────────────────
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
      const businessName = apt.businesses?.name || 'tu barbería';
      const barberName = apt.barbers?.name || 'el barbero';
      const serviceName = apt.services?.name || 'tu servicio';
      const hora = formatTime(apt.start_time);
      const dia = formatDate(apt.appointment_date);

      const msg =
        `⏰ *Recordatorio de cita — ${businessName}*\n\n` +
        `Hola ${apt.customer_name}, recuerda tu cita mañana:\n` +
        `✂️ ${serviceName} con ${barberName}\n` +
        `📅 ${dia} a las ${hora}\n\n` +
        `Responde:\n` +
        `✅ *CONFIRMO* — para confirmar tu asistencia\n` +
        `❌ *CANCELAR* — para cancelar la cita`;

      try {
        await sendWhatsApp(apt.customer_phone, msg);
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
    const windowStart = nowMins + 50;  // entre 50 y 80 minutos desde ahora
    const windowEnd = nowMins + 80;

    const { data: apt1h } = await supabase
      .from('appointments')
      .select(`
        id, customer_name, customer_phone,
        appointment_date, start_time,
        barbers(name), businesses(name)
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

      const msg =
        `⏰ Tu cita es en aproximadamente 1 hora\n\n` +
        `💈 *${businessName}* · ${formatTime(apt.start_time)}\n` +
        `Con ${barberName}\n\n` +
        `¡Te esperamos!`;

      try {
        await sendWhatsApp(apt.customer_phone, msg);
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
  const link = business.whatsapp_booking_link || `https://spaceyreserve.netlify.app/book/${business.slug || ''}`;
  return `Gracias por escribir a *${business.name}* 🌙\n\nNuestro horario de atención es de ${business.whatsapp_bot_start_hour} a ${business.whatsapp_bot_end_hour}. Te responderemos en cuanto volvamos a abrir.\n\n¿Quieres reservar en línea? 👉 ${link}`;
}

// ── Slot-filling: LLM extractor (free-form → structured) ──────────────────────
async function extractBooking(message, services, barbers, awaiting = []) {
  const svcNames = services.map(s => s.name).join(', ');
  const barberNames = barbers.map(b => b.name).join(', ');
  const askedMap = { name: 'el nombre', service: 'el servicio', barber: 'el barbero', date: 'el día', time: 'la hora' };
  const askedLine = awaiting.length
    ? `\nEl bot acaba de preguntar por: ${awaiting.map(a => askedMap[a] || a).join(', ')}. Si el mensaje es la respuesta, asígnalo a ese campo (una sola palabra normalmente es ${awaiting.includes('name') ? 'el nombre del cliente' : 'ese dato'}).`
    : '';
  const sys = `Extrae datos de una solicitud de cita de barbería. Devuelve SOLO un objeto JSON:
{"name":string|null,"service":string|null,"barber":string|null,"date":string|null,"time":string|null}
- name: el nombre del cliente si aparece (puede ser una sola palabra en minúscula). null si no.
- service: SOLO si nombra un servicio de esta lista: ${svcNames}. No lo asumas. null si no lo menciona.
- barber: SOLO si el cliente pide explícitamente con quién atenderse (ej. "con Pepe"). Si un nombre aparece como el nombre del CLIENTE, no es el barbero. Lista: ${barberNames || '(ninguno)'}. null si no lo pide.
- date: "today", "tomorrow", un día de la semana en español, o YYYY-MM-DD. null si no lo menciona.
- time: HH:MM en 24h, ej "15:00". null si no la menciona.${askedLine}
No inventes datos que no estén en el mensaje.`;
  try {
    const c = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: message }],
      temperature: 0,
      max_tokens: 150,
      response_format: { type: 'json_object' },
    });
    return JSON.parse(c.choices[0].message.content) || {};
  } catch (e) {
    console.error('[extractBooking] failed:', e.message);
    return {};
  }
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

// Toque ligero de personalidad para los mensajes ancla (apertura y confirmación final)
function botVibe(business) {
  switch (business?.whatsapp_bot_personality) {
    case 'cool':    return { open: '¡Qué lo qué! 💈', ok: '¡Brutal' };
    case 'casual':  return { open: '¡Saludos! 💈',   ok: '¡Listo' };
    case 'premium': return { open: 'Bienvenido 💈',  ok: 'Confirmado' };
    default:        return { open: '¡Saludos! 💈',   ok: '¡Listo' }; // quick
  }
}

// Único saludo/opener del bot — UNA sola fuente de verdad
function opener(business, services, barbers, bookingLink) {
  const vibe = botVibe(business);
  const svcList = (services || []).map(s => `• ${s.name} — $${s.price}`).join('\n');
  const barberLine = (barbers || []).map(b => b.name).join(' • ');
  const link = bookingLink || business.whatsapp_booking_link || `https://spaceyreserve.netlify.app/book/${business.slug || ''}`;
  return `${vibe.open} Soy el asistente de *${business.name}*.\nPara tu cita dime en un mensaje: tu nombre, el servicio y el barbero que prefieres.\n\n✂️ *Servicios:*\n${svcList}${barberLine ? `\n\n💈 *Equipo:*\n${barberLine}` : ''}\n\nO reserva directo: ${link}`;
}

async function handleMessage(phone, message, businessId) {
  const session = await getSession(phone);
  const { business, barbers, services } = await getBusinessInfo(businessId);
  const msg = message.trim();
  const msgLower = msg.toLowerCase();
  const bookingLink = business.whatsapp_booking_link || `https://spaceyreserve.netlify.app/book/${business.slug || 'annlobarberia'}`;

  // Fuera de horario: si el dueño activó el horario automático, responder y no procesar
  const offHours = getOutOfHoursReply(business);
  if (offHours) return offHours;

  // ── Reset de flujo (solo cuando está en medio de un proceso) ──────────────
  if (session.state !== 'idle' &&
      RESET_FLOW_WORDS.some(w => msgLower === w)) {
    session.state = 'idle';
    session.data = {};
    return `Proceso cancelado. Escribe *"hola"* para comenzar de nuevo 👋`;
  }

  // Un saludo a secas reinicia el flujo → siempre muestra el opener (no se queda pegado)
  if (session.state !== 'idle' && GREETINGS.has(msgLower)) {
    session.state = 'idle';
    session.data = {};
  }

  // ── IDLE ──────────────────────────────────────────────────────────────────
  if (session.state === 'idle') {

    // Respuesta a recordatorio: CONFIRMO
    if (msgLower === 'confirmo' || msgLower === 'confirmar' || msgLower === 'si confirmo') {
      const existing = await getActiveAppointment(phone, businessId);
      if (existing) {
        // Ya está confirmada en DB; este es un acuse de recibo del cliente
        const barber = barbers.find(b => b.id === existing.barber_id);
        return `✅ ¡Perfecto, ${existing.customer_name}! Tu cita está confirmada.\n\n💈 ${barber?.name || 'Tu barbero'} te espera el ${formatDate(existing.appointment_date)} a las ${formatTime(existing.start_time)}. ¡Nos vemos! 🙌`;
      }
      return `No encontré una cita activa para tu número. Escribe *"cita"* para agendar una nueva.`;
    }

    // Respuesta a recordatorio: CANCELAR (la palabra completa "cancelar" sin cita en proceso)
    if (msgLower === 'cancelar' || msgLower === 'cancelar cita') {
      const existing = await getActiveAppointment(phone, businessId);
      if (existing) {
        const barber = barbers.find(b => b.id === existing.barber_id);
        const service = services.find(s => s.id === existing.service_id);
        session.state = 'cancel_confirm';
        session.data.existingAppointmentId = existing.id;
        session.data.customerName = existing.customer_name;
        return `⚠️ ¿Seguro que quieres cancelar?\n\n✂️ ${service?.name || 'Servicio'}\n💈 ${barber?.name || 'Barbero'}\n🗓 ${formatDate(existing.appointment_date)} a las ${formatTime(existing.start_time)}\n\n1. Sí, cancelar\n2. No, mantenerla`;
      }
      // Sin cita activa → comportamiento de reset normal (cae abajo)
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

    // Saludo, intención de cita, o mensaje con datos de booking
    const looksBooking = bookingLogic.looksLikeBooking(msg, services);
    if (GREETINGS.has(msgLower) || BOOKING_WORDS.some(w => msgLower.includes(w)) || looksBooking) {
      session.data.bk = {};
      // Si el mensaje YA trae datos → procesar directamente sin reconocimiento
      if (looksBooking || bookingLogic.hasBookingContent(msg, services, barbers, [...GREETINGS], BOOKING_WORDS)) {
        session.state = 'booking';
        const extracted = await extractBooking(msg, services, barbers, []);
        return await bookingLogic.decideBookingReply({ session, msg, extracted, services, barbers, getSlots: getAvailableSlots, getUpcoming });
      }
      // Solo saludo / keyword → verificar historial antes de mostrar el opener
      const history = await getClientHistory(phone, businessId);
      if (history.hasHistory && history.name) {
        if (history.activeAppointment) {
          const appt = history.activeAppointment;
          const barber = barbers.find(b => b.id === appt.barber_id);
          const service = services.find(s => s.id === appt.service_id);
          session.state = 'returning_menu';
          session.data.customerName = history.name;
          return `¡Hola de nuevo, ${history.name}! 👋\n\nTienes una cita el *${formatDate(appt.appointment_date)}* a las *${formatTime(appt.start_time)}* con ${barber?.name || 'tu barbero'}.\n\n¿Qué necesitas?\n1. Reagendar\n2. Agendar otra cita\n3. Preguntar algo`;
        }
        if (history.lastService && history.lastBarber) {
          session.state = 'lo_de_siempre';
          session.data.lastService = history.lastService;
          session.data.lastBarber = history.lastBarber;
          session.data.customerName = history.name;
          return `¡Hola de nuevo, ${history.name}! 👋\n\n¿Lo de siempre — *${history.lastService.name}* con *${history.lastBarber.name}*? 😊\n\n1. Sí, ese\n2. No, quiero otra cosa`;
        }
        session.state = 'booking';
        session.data.bk = { name: history.name };
        session.data.awaiting = ['service', 'date', 'time'];
        return `¡Hola de nuevo, ${history.name}! 👋 ¿En qué te ayudo?\n${services.map(s => `• ${s.name} $${s.price}`).join('\n')}`;
      }
      // Cliente nuevo
      session.state = 'booking';
      session.data.awaiting = ['name', 'service', 'date', 'time'];
      return opener(business, services, barbers, bookingLink);
    }

    // Pro/Premium: Groq para preguntas generales
    if (canUseGroq(business)) {
      return askGroq(session, msg, business, services);
    }

    // Cualquier otro mensaje → abre el flujo con el opener
    session.state = 'booking';
    session.data.bk = {};
    session.data.awaiting = ['name', 'service', 'date', 'time'];
    return opener(business, services, barbers, bookingLink);
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

    // El bot ya confirma aquí → borra el template duplicado del trigger
    await suppressBotTemplate(apptId, 'rescheduled');

    return `✅ *¡Cita reagendada, ${customerName}!*\n\n✂️ ${service?.name || 'Servicio'}\n💈 ${barber?.name || 'Barbero'}\n📅 ${formatDate(newDate)} a las ${formatTime(startTime)}\n\n¡Te esperamos! 💈`;
  }

  // ── CANCEL CONFIRM (acción destructiva: ambigüedad = re-preguntar, NUNCA asumir) ──
  if (session.state === 'cancel_confirm') {
    const n = msgLower.replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i').replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').trim();
    const apptId = session.data.existingAppointmentId;
    const name = session.data.customerName || 'cliente';

    let decision = null;
    // MANTENER (palabras explícitas; "no" exacto, no cualquier frase con "no")
    if (n === '2' || n === 'no' || /\b(mantenla|mantenerla|mantener|dejala|dejarla|no canceles|no cancelar|no la canceles)\b/.test(n) || /\bmejor no\b/.test(n)) decision = 'keep';
    // CANCELAR (palabras explícitas)
    else if (n === '1' || n === 'si' || /\b(cancela|cancelala|dale|confirmo|eso|hazlo|borrala|borra|elimina|eliminala)\b/.test(n) || /\bcancel/.test(n)) decision = 'cancel';
    // Cualquier otra cosa (incl. "no sé") → decision queda null → re-preguntar

    if (decision === 'cancel') {
      const { error } = await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', apptId);
      session.state = 'idle'; session.data = {};
      if (error) return `Hubo un error al cancelar. Contáctanos directamente.`;
      await suppressBotTemplate(apptId, 'cancelled'); // el bot ya confirma aquí
      return `Listo, ${name}, tu cita quedó *cancelada*. Escribe *"cita"* cuando quieras agendar otra. 👋`;
    }
    if (decision === 'keep') {
      session.state = 'idle'; session.data = {};
      return `¡Perfecto, ${name}! Tu cita se *mantiene*. ¡Te esperamos! 💈`;
    }
    // Ambiguo → re-preguntar (sigue en cancel_confirm, no se pierde el estado)
    return `Para estar seguro 🙂 responde *1* para CANCELAR la cita, o *2* para MANTENERLA.`;
  }

  // ── RETURNING MENU (cliente con cita activa, elige qué hacer) ────────────
  if (session.state === 'returning_menu') {
    const n = msg.trim();
    if (n === '1') {
      const existing = await getActiveAppointment(phone, businessId);
      if (!existing) { session.state = 'idle'; session.data = {}; return opener(business, services, barbers, bookingLink); }
      const barber = barbers.find(b => b.id === existing.barber_id);
      const service = services.find(s => s.id === existing.service_id);
      session.state = 'reagendar_confirm';
      session.data.existingAppointmentId = existing.id;
      session.data.existingBarberId = existing.barber_id;
      session.data.existingServiceId = existing.service_id;
      session.data.customerName = session.data.customerName || existing.customer_name;
      return `📅 Tu cita actual:\n\n✂️ ${service?.name || 'Servicio'}\n💈 ${barber?.name || 'Barbero'}\n🗓 ${formatDate(existing.appointment_date)} a las ${formatTime(existing.start_time)}\n\n¿Quieres cambiarla?\n1. Sí, reagendar\n2. No, mantenerla`;
    }
    if (n === '2') {
      const name = session.data.customerName;
      session.state = 'booking';
      session.data.bk = name ? { name } : {};
      session.data.awaiting = name ? ['service', 'date', 'time'] : ['name', 'service', 'date', 'time'];
      return opener(business, services, barbers, bookingLink);
    }
    if (n === '3') {
      session.state = 'idle';
      session.data = {};
      if (canUseGroq(business)) return askGroq(session, msg, business, services);
      return `¡Claro! Escribe tu pregunta y te ayudo 😊`;
    }
    return `Responde *1* para reagendar, *2* para nueva cita, o *3* para preguntar algo.`;
  }

  // ── LO DE SIEMPRE (cliente recurrente sin cita activa) ─────────────────
  if (session.state === 'lo_de_siempre') {
    const n = msgLower.trim();
    const yes = n === '1' || n === 'sí' || n === 'si' || n === 'dale' || n === 'eso' || n === 'ok' || n === 'claro';
    const no  = n === '2' || n === 'no' || n.includes('otra cosa') || n.includes('otro');
    if (yes) {
      const lastSvc = session.data.lastService;
      const lastBar = session.data.lastBarber;
      const name    = session.data.customerName;
      const svc = services.find(s => s.id === lastSvc?.id);
      const bar = barbers.find(b => b.id === lastBar?.id);
      if (!svc || !bar) {
        session.state = 'booking';
        session.data.bk = name ? { name } : {};
        session.data.awaiting = ['service', 'date', 'time'];
        return `Parece que algo cambió desde tu última visita 😊 Elige un servicio:\n${services.map(s => `• ${s.name} $${s.price}`).join('\n')}`;
      }
      session.state = 'booking';
      session.data.bk = {
        name,
        serviceId: svc.id, serviceName: svc.name,
        serviceDuration: svc.duration_minutes || 30, servicePrice: svc.price,
        barberId: bar.id, barberName: bar.name,
      };
      session.data.awaiting = ['date', 'time'];
      const upcoming = await getUpcoming(bar.id, 2, 3);
      if (!upcoming.length) return `No hay espacios próximos para ${bar.name} 😕 Escribe *"cita"* para elegir otro barbero.`;
      const offered = [];
      const parts   = [];
      for (const g of upcoming) {
        for (const t of g.slots) offered.push({ date: g.date, time: t });
        parts.push(`${formatDate(g.date)} a las ${g.slots.map(s => formatTime(s)).join(' o ')}`);
      }
      session.data.bk.offeredSlots = offered;
      return `¡Perfecto! *${svc.name} con ${bar.name}* — ¿cuándo lo quieres?\n\n${parts.join('\n')}\n\n¿Cuál te queda bien? 🙂`;
    }
    if (no) {
      const name = session.data.customerName;
      session.state = 'booking';
      session.data.bk = name ? { name } : {};
      session.data.awaiting = name ? ['service', 'date', 'time'] : ['name', 'service', 'date', 'time'];
      return opener(business, services, barbers, bookingLink);
    }
    return `Responde *1* para lo de siempre o *2* para elegir otra cosa 😊`;
  }

  // ── BOOKING (slot-filling: extrae todo del mensaje libre) ─────────────────
  if (session.state === 'booking') {
    const extracted = await extractBooking(msg, services, barbers, session.data.awaiting || []);
    return await bookingLogic.decideBookingReply({
      session, msg, extracted, services, barbers, getSlots: getAvailableSlots, getUpcoming,
    });
  }

  // ── CONFIRM (un solo mensaje de resumen → sí/no) ──────────────────────────
  if (session.state === 'confirm') {
    // Normaliza acentos para que "sí" cuente como "si" (\b no reconoce la í)
    const norm = msgLower.replace(/[áàä]/g,'a').replace(/[éèë]/g,'e').replace(/[íìï]/g,'i').replace(/[óòö]/g,'o').replace(/[úùü]/g,'u');
    const yes = msg === '1' || /^(si|dale|ok|oka|confirmo|claro|correcto|listo|va)\b/.test(norm);
    const no  = msg === '2' || /^(no|cambiar|cambia|espera|mejor)\b/.test(norm);

    if (yes) {
      const bk = session.data.bk || {};
      const [bh, bm] = bk.time.split(':').map(Number);
      const endMin = bh * 60 + bm + (bk.serviceDuration || 30);
      const endTime = `${String(Math.floor(endMin/60)).padStart(2,'0')}:${String(endMin%60).padStart(2,'0')}`;

      const { appt, error } = await createAppointment({
        businessId,
        barberId: bk.barberId,
        serviceId: bk.serviceId,
        customerName: bk.name,
        customerPhone: phone,
        date: bk.date,
        startTime: bk.time,
        endTime,
      });

      if (error) {
        console.error('Appointment error:', error);
        session.state = 'idle';
        session.data = {};
        return `Uy, no pude guardar la cita 😕 Intenta de nuevo en un momento.`;
      }

      // El bot ya confirma aquí → borra el template duplicado que encoló el trigger
      await suppressBotTemplate(appt.id, 'created');

      const v = botVibe(business);
      const reply = `✅ ${v.ok}, ${bk.name}! Te esperamos el ${formatDate(bk.date)} a las ${formatTime(bk.time)}. 💈`;

      session.state = 'idle';
      session.data = {};
      return reply;
    }

    if (no) {
      session.state = 'booking';
      return `Claro, dime el dato correcto (servicio, día u hora) 🙂`;
    }

    return `¿Confirmo la cita? Responde *sí* o *no*.`;
  }

  // Fallback
  session.state = 'idle';
  return `Escribe *"hola"* para ver servicios, *"cita"* para agendar, o *"cambiar mi cita"* para reagendar.`;
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
function validateTwilioSignature(req, res, next) {
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

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );

  if (!isValid) {
    console.warn(`[SECURITY] Invalid Twilio signature from ${req.ip} — rejected`);
    return res.status(403).send('Forbidden');
  }

  next();
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
      .from('twilio_settings').select('business_id')
      .eq('whatsapp_from', To)
      .eq('is_active', true)
      .maybeSingle();

    if (error || !twilioSettings) {
      console.warn(`[routing] No active twilio_settings for To=${To}`);
      await sendWhatsApp(phone, 'Servicio no disponible en este momento.');
      return;
    }

    const reply = await handleMessage(phone, Body, twilioSettings.business_id);
    // Persist session after every message (write-through)
    if (sessions[phone]) await saveSession(phone, sessions[phone]);
    await sendWhatsApp(phone, reply);
    // Medición de uso: 1 entrante procesado + 1 respuesta enviada
    await bumpUsage(twilioSettings.business_id, 'inbound', 1);
    await bumpUsage(twilioSettings.business_id, 'outbound', 1);
  } catch (err) {
    console.error('Webhook error:', err);
    await sendWhatsApp(phone, 'Ocurrió un error. Intenta de nuevo.');
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.2.0-slotfill' }));

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
  console.log('✅ BarberBot v2.2.0-slotfill started');
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('❌ Server error:', err);
  process.exit(1);
});
