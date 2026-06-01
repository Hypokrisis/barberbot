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
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_FROM',
  'GROQ_API_KEY'
];

const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:');
  missingEnvVars.forEach(v => console.error(`   - ${v}`));
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Clients ──────────────────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── In-memory conversation state ─────────────────────────────────────────────
const sessions = {};

// ── Helpers ───────────────────────────────────────────────────────────────────
function getSession(phone) {
  if (!sessions[phone]) sessions[phone] = { history: [], state: 'idle', data: {} };
  return sessions[phone];
}

function dayName(d) {
  return ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'][d];
}

async function getBusinessInfo(businessId) {
  const { data: business } = await supabase
    .from('businesses').select('*').eq('id', businessId).single();
  const { data: barbers } = await supabase
    .from('barbers').select('id,name,phone_e164').eq('business_id', businessId).eq('is_active', true);
  const { data: services } = await supabase
    .from('services').select('id,name,duration_minutes,price').eq('business_id', businessId).eq('is_active', true);
  return { business, barbers, services };
}

async function getAvailableSlots(barberId, date) {
  const dow = new Date(date + 'T12:00:00').getDay();
  const { data: schedule } = await supabase
    .from('schedules')
    .select('start_time,end_time')
    .eq('barber_id', barberId)
    .eq('day_of_week', dow)
    .eq('is_active', true)
    .maybeSingle();

  if (!schedule) return [];

  const { data: appointments } = await supabase
    .from('appointments')
    .select('start_time,end_time')
    .eq('barber_id', barberId)
    .eq('appointment_date', date)
    .neq('status', 'cancelled');

  const slots = [];
  let [sh, sm] = schedule.start_time.split(':').map(Number);
  const [eh, em] = schedule.end_time.split(':').map(Number);
  const endMins = eh * 60 + em;

  while (sh * 60 + sm + 30 <= endMins) {
    const slotStart = `${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`;
    const busy = appointments?.some(a => a.start_time.slice(0,5) === slotStart);
    if (!busy) slots.push(slotStart);
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
    if (slots.length > 0) {
      results.push({ date: dateStr, day: dayName(d.getDay()), slots: slots.slice(0, 3) });
    }
    offset++;
  }
  return results;
}

async function createAppointment(data) {
  const { data: appt, error } = await supabase
    .from('appointments')
    .insert({
      business_id: data.businessId,
      barber_id: data.barberId,
      service_id: data.serviceId,
      customer_name: data.customerName,
      customer_phone: data.customerPhone,
      appointment_date: data.date,
      start_time: data.startTime,
      end_time: data.endTime,
      status: 'confirmed'
    })
    .select()
    .single();
  return { appt, error };
}

async function sendWhatsApp(to, body) {
  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: `whatsapp:${to}`,
    body
  });
}

// ── AI conversation handler ───────────────────────────────────────────────────
async function handleMessage(phone, message, businessId) {
  const session = getSession(phone);
  const { business, barbers, services } = await getBusinessInfo(businessId);

  const systemPrompt = `Eres el asistente de ${business.name} en ${business.city}, PR. Ayudas a agendar citas por WhatsApp. Sé breve y directo.

Barberos: ${barbers.map(b => `${b.name} (ID:${b.id})`).join(', ')}
Servicios: ${services.map(s => `${s.name} $${s.price} ${s.duration_minutes}min (ID:${s.id})`).join(', ')}
Estado: ${JSON.stringify(session.data)}

Flujo: nombre → servicio → barbero → fecha → horario → confirmar.

Cuando el cliente pregunte qué fechas o días hay disponibles, responde SOLO con este JSON:
{"action":"get_dates","barberId":"ID_DEL_BARBERO"}

Cuando tengas fecha y quiera ver horarios, responde SOLO con este JSON:
{"action":"get_slots","barberId":"ID","date":"YYYY-MM-DD"}

Cuando tengas todos los datos, responde SOLO con este JSON:
{"action":"create_appointment","customerName":"...","serviceId":"ID","barberId":"ID","date":"YYYY-MM-DD","startTime":"HH:MM"}

IMPORTANTE: cuando respondas con JSON, escribe ÚNICAMENTE el JSON, sin texto antes ni después.`;

  session.history.push({ role: 'user', content: message });

  const completion = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: systemPrompt },
      ...session.history
    ],
    temperature: 0.4,
    max_tokens: 300
  });

  const responseText = completion.choices[0].message.content.trim();

  // Extract JSON from response (handles cases where model wraps it in text/markdown)
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const action = JSON.parse(jsonMatch[0]);

      if (action.action === 'get_dates') {
        const barberId = action.barberId;
        const days = await getNextAvailableDays(barberId, 5);
        if (days.length === 0) {
          const reply = `No hay fechas disponibles en los próximos 30 días. Contáctanos directamente.`;
          session.history.push({ role: 'assistant', content: reply });
          return reply;
        }
        const lines = days.map(d => `📅 ${d.day} ${d.date}: ${d.slots.join(', ')}...`);
        const reply = `Próximas fechas disponibles:\n${lines.join('\n')}\n\n¿Cuál prefieres?`;
        session.history.push({ role: 'assistant', content: reply });
        return reply;
      }

      if (action.action === 'get_slots') {
        const slots = await getAvailableSlots(action.barberId, action.date);
        if (slots.length === 0) {
          const reply = `No hay horarios para el ${action.date}. ¿Otra fecha?`;
          session.history.push({ role: 'assistant', content: reply });
          return reply;
        }
        const reply = `Horarios del ${action.date}:\n${slots.map((s,i) => `${i+1}. ${s}`).join('\n')}\n\n¿Cuál prefieres?`;
        session.data.availableSlots = slots;
        session.data.selectedDate = action.date;
        session.data.selectedBarberId = action.barberId;
        session.history.push({ role: 'assistant', content: reply });
        return reply;
      }

      if (action.action === 'create_appointment') {
        const service = services.find(s => s.id === action.serviceId);
        const [h, m] = action.startTime.split(':').map(Number);
        const endMin = h * 60 + m + (service?.duration_minutes || 30);
        const endTime = `${String(Math.floor(endMin/60)).padStart(2,'0')}:${String(endMin%60).padStart(2,'0')}`;

        const { appt, error } = await createAppointment({
          businessId,
          barberId: action.barberId,
          serviceId: action.serviceId,
          customerName: action.customerName,
          customerPhone: phone,
          date: action.date,
          startTime: action.startTime,
          endTime
        });

        if (error) {
          const reply = `Error al crear la cita. Intenta de nuevo.`;
          session.history.push({ role: 'assistant', content: reply });
          return reply;
        }

        sessions[phone] = { history: [], state: 'idle', data: {} };

        const barber = barbers.find(b => b.id === action.barberId);
        const bookingLink = business.whatsapp_booking_link || business.website_url || '';
        const linkLine = bookingLink ? `\n🔗 ${bookingLink}` : '';
        const reply = `✅ ¡Cita confirmada!\n\n👤 ${action.customerName}\n✂️ ${service?.name}\n💈 ${barber?.name}\n📅 ${action.date} ${action.startTime}${linkLine}\n\n¡Te esperamos!`;
        return reply;
      }
    } catch (e) {
      // JSON parse failed, fall through to normal response
    }
  }

  session.history.push({ role: 'assistant', content: responseText });
  return responseText;
}

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const { Body, From } = req.body;
  const phone = From.replace('whatsapp:', '');

  // Respond immediately to Twilio to prevent retries and double messages
  res.status(200).end();

  console.log(`Message from ${phone}: ${Body}`);

  try {
    const { data: twilioSettings, error: settingsError } = await supabase
      .from('twilio_settings')
      .select('business_id')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (settingsError || !twilioSettings) {
      console.error('Twilio settings error:', settingsError);
      await sendWhatsApp(phone, 'Servicio no disponible en este momento.');
      return;
    }

    const reply = await handleMessage(phone, Body, twilioSettings.business_id);
    await sendWhatsApp(phone, reply);
  } catch (err) {
    console.error('Error:', err);
    await sendWhatsApp(phone, 'Ocurrió un error. Intenta de nuevo.');
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log('✅ BarberBot started successfully');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
});

server.on('error', (err) => {
  console.error('❌ Server error:', err);
  process.exit(1);
});
