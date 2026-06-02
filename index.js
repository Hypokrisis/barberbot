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

// ── Format helpers ────────────────────────────────────────────────────────────
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
    .from('appointments').select('start_time')
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
  const today = new Date();
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

async function createAppointment(data) {
  const { data: appt, error } = await supabase
    .from('appointments').insert({
      business_id: data.businessId,
      barber_id: data.barberId,
      service_id: data.serviceId,
      customer_name: data.customerName,
      customer_phone: data.customerPhone,
      appointment_date: data.date,
      start_time: data.startTime,
      end_time: data.endTime,
      status: 'confirmed'
    }).select().single();
  return { appt, error };
}

async function sendWhatsApp(to, body) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: `whatsapp:${to}`,
    body
  });
}

// ── Groq fallback (Pro/Premium only — general questions) ──────────────────────
async function askGroq(session, message, business, services) {
  const systemPrompt = `Eres el asistente de ${business.name}, ${business.city} PR. Responde en máximo 2 líneas. Servicios: ${services.map(s => `${s.name} $${s.price}`).join(', ')}. Para agendar deben escribir "cita".`;
  session.history.push({ role: 'user', content: message });
  const completion = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [{ role: 'system', content: systemPrompt }, ...session.history.slice(-6)],
    temperature: 0.3,
    max_tokens: 150
  });
  const reply = completion.choices[0].message.content.trim();
  session.history.push({ role: 'assistant', content: reply });
  return reply;
}

// ── Reports ───────────────────────────────────────────────────────────────────
async function buildDailyReport(business, services) {
  const today = new Date().toISOString().split('T')[0];

  const { data: appts } = await supabase
    .from('appointments')
    .select('customer_name, start_time, service_id, status')
    .eq('business_id', business.id)
    .eq('appointment_date', today)
    .neq('status', 'cancelled')
    .order('start_time', { ascending: true });

  if (!appts || appts.length === 0) return null;

  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();

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
    msg += `⏭️ *Próxima cita:*\n`;
    msg += `• ${next.customer_name} a las ${formatTime(next.start_time)}`;
    if (nextSvc) msg += ` — ${nextSvc.name}`;
    msg += `\n`;
  }

  if (upcoming.length > 1) {
    msg += `\n📋 Restantes del día: *${upcoming.length - 1}*\n`;
    upcoming.slice(1, 4).forEach(a => {
      const svc = services.find(s => s.id === a.service_id);
      msg += `• ${formatTime(a.start_time)} ${a.customer_name}${svc ? ` (${svc.name})` : ''}\n`;
    });
    if (upcoming.length - 1 > 3) msg += `...y ${upcoming.length - 4} más\n`;
  }

  if (upcoming.length === 0) {
    msg += `\n✅ No quedan citas pendientes por hoy.`;
  }

  return msg;
}

async function buildClosingReport(business, services) {
  const today = new Date().toISOString().split('T')[0];

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

// ── Send 2-hour report to all active Pro/Premium businesses ───────────────────
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
      if (!ownerPhone) {
        console.warn(`[Report] No owner phone for ${business.name}`);
        continue;
      }

      const { data: services } = await supabase
        .from('services').select('id,name,price')
        .eq('business_id', business.id).eq('is_active', true);

      const msg = await buildDailyReport(business, services || []);
      if (!msg) {
        console.log(`[Report] No appointments today for ${business.name}, skipping`);
        continue;
      }

      await sendWhatsApp(ownerPhone, msg);
      console.log(`[Report] Sent bi-hourly report to ${business.name} (${ownerPhone})`);
    }
  } catch (err) {
    console.error('[Cron] Error sending bi-hourly reports:', err);
  }
}

// ── Send closing report to Premium businesses ─────────────────────────────────
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
      console.log(`[Report] Sent closing report to ${business.name}`);
    }
  } catch (err) {
    console.error('[Cron] Error sending closing reports:', err);
  }
}

// ── Send proactive re-engagement to inactive clients (Premium only) ───────────
async function sendProactiveReengagement() {
  console.log('[Cron] Sending proactive re-engagement messages...');
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
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - inactiveDays);
      const cutoffStr = cutoff.toISOString().split('T')[0];

      // Find customers who had an appointment before cutoff and none after
      const { data: inactiveClients } = await supabase.rpc('get_inactive_clients', {
        p_business_id: business.id,
        p_cutoff_date: cutoffStr
      }).catch(() => ({ data: null }));

      // Fallback: direct query if RPC not available
      if (!inactiveClients) {
        const { data: oldAppts } = await supabase
          .from('appointments')
          .select('customer_name, customer_phone')
          .eq('business_id', business.id)
          .lt('appointment_date', cutoffStr)
          .neq('status', 'cancelled')
          .not('customer_phone', 'is', null);

        if (!oldAppts || oldAppts.length === 0) continue;

        // Dedupe by phone
        const seen = new Set();
        const candidates = oldAppts.filter(a => {
          if (seen.has(a.customer_phone)) return false;
          seen.add(a.customer_phone);
          return true;
        });

        // Check each has no recent appointment
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
            console.log(`[Proactive] Sent re-engagement to ${client.customer_name} for ${business.name}`);
            // Small delay to avoid Twilio rate limits
            await new Promise(r => setTimeout(r, 1000));
          } catch (err) {
            console.error(`[Proactive] Failed to send to ${client.customer_phone}:`, err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Cron] Error sending proactive messages:', err);
  }
}

// ── State machine ─────────────────────────────────────────────────────────────
const GREETINGS = new Set(['hola','hi','hello','buenas','hey','ola','buenos dias',
  'buen dia','buenas tardes','buenas noches','info','información','informacion']);
const BOOKING_WORDS = ['cita','reservar','agendar','turno','quiero','reserva','book'];
const KEYWORDS = {
  cancel: ['cancelar','cancel','cancela'],
  reschedule: ['reagendar','cambiar cita','reprogramar'],
  yes: ['sí','si','yes','ok','bueno','dale','confirmo'],
  no: ['no','nop','cancelar'],
};

function matchesKeyword(msgLower, list) {
  return list.some(w => msgLower.includes(w));
}

async function handleMessage(phone, message, businessId) {
  const session = getSession(phone);
  const { business, barbers, services } = await getBusinessInfo(businessId);
  const msg = message.trim();
  const msgLower = msg.toLowerCase();
  const bookingLink = business.whatsapp_booking_link || `https://spaceyreserve.netlify.app/book/${business.slug || 'annlobarberia'}`;
  const plan = getPlan(business);

  // ── Global keywords (all tiers) ────────────────────────────────────────────
  if (matchesKeyword(msgLower, KEYWORDS.cancel) && session.state !== 'idle') {
    session.state = 'idle';
    session.data = {};
    return `Proceso cancelado. Escribe *"hola"* para comenzar de nuevo.`;
  }

  // ── IDLE ──────────────────────────────────────────────────────────────────
  if (session.state === 'idle') {
    if (GREETINGS.has(msgLower)) {
      const svcList = services.map(s => `• ${s.name}: $${s.price}`).join('\n');
      return `¡Hola! Soy el asistente de *${business.name}* 💈\n\n*Servicios:*\n${svcList}\n\nEscribe *"cita"* para agendar por aquí 📅`;
    }
    if (BOOKING_WORDS.some(w => msgLower.includes(w))) {
      session.state = 'name';
      return `¡Perfecto! 💈 ¿Cuál es tu nombre?`;
    }

    // Pro/Premium: use Groq for general questions
    if (canUseGroq(business)) {
      return askGroq(session, msg, business, services);
    }

    // Basic/Trial: keyword-only fallback
    const svcList = services.map(s => `• ${s.name}: $${s.price}`).join('\n');
    return `¡Hola! Soy el asistente de *${business.name}* 💈\n\n*Servicios:*\n${svcList}\n\nEscribe *"cita"* para agendar o visita:\n${bookingLink}`;
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

    const { error } = await createAppointment({
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

    sessions[phone] = { state: 'idle', data: {}, history: [], lastActivity: Date.now() };

    const barber = barbers.find(b => b.id === session.data.barberId);
    return `✅ *¡Cita confirmada para ${session.data.customerName}!*\n\n✂️ ${service.name}\n💈 ${barber?.name}\n📅 ${formatDate(session.data.selectedDate)} a las ${formatTime(startTime)}\n\n🔗 Ver/cancelar cita:\n${bookingLink}\n\n¡Te esperamos! 💈`;
  }

  // Fallback
  session.state = 'idle';
  return `Escribe *"hola"* para ver servicios o *"cita"* para agendar.`;
}

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const { Body, From } = req.body;
  const phone = From.replace('whatsapp:', '');

  res.status(200).end(); // Respond immediately to prevent Twilio retries

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

app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.0.0' }));

// ── Manual report trigger (for testing) ──────────────────────────────────────
app.post('/admin/report', async (req, res) => {
  const { type = 'bihourly' } = req.body;
  try {
    if (type === 'closing') {
      await sendClosingReports();
    } else {
      await sendBiHourlyReports();
    }
    res.json({ status: 'ok', type });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cron jobs ─────────────────────────────────────────────────────────────────
// Every 2 hours from 8am to 6pm (Pro + Premium)
cron.schedule('0 8,10,12,14,16,18 * * *', () => {
  sendBiHourlyReports();
});

// Daily closing report at 8pm (Premium only)
cron.schedule('0 20 * * *', () => {
  sendClosingReports();
});

// Weekly proactive re-engagement every Monday at 9am (Premium only)
cron.schedule('0 9 * * 1', () => {
  sendProactiveReengagement();
});

console.log('✅ Cron jobs registered: bi-hourly reports, closing report, proactive re-engagement');

// ── Server ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log('✅ BarberBot started successfully');
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('❌ Server error:', err);
  process.exit(1);
});
