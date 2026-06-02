// Polyfill WebSocket for Node.js < 22 (required by Supabase realtime)
if (!globalThis.WebSocket) {
  globalThis.WebSocket = require('ws');
}

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const Groq = require('groq-sdk');

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

// ── Groq fallback (only for general questions outside booking flow) ────────────
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

// ── State machine ─────────────────────────────────────────────────────────────
const GREETINGS = new Set(['hola','hi','hello','buenas','hey','ola','buenos dias',
  'buen dia','buenas tardes','buenas noches','info','información','informacion']);
const BOOKING_WORDS = ['cita','reservar','agendar','turno','quiero','reserva','book'];

async function handleMessage(phone, message, businessId) {
  const session = getSession(phone);
  const { business, barbers, services } = await getBusinessInfo(businessId);
  const msg = message.trim();
  const msgLower = msg.toLowerCase();
  const bookingLink = business.whatsapp_booking_link || 'https://spaceyreserve.netlify.app/book/annlobarberia';

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
    return askGroq(session, msg, business, services);
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

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log('✅ BarberBot started successfully');
  console.log(`🚀 Server running on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('❌ Server error:', err);
  process.exit(1);
});
