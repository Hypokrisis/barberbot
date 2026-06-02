# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # Production server
npm run dev      # Development with nodemon (auto-restart)
```

No build step, no tests, no linter configured.

## Architecture

Single-file Express app (`index.js`) — everything lives there.

**Request flow:**
```
Twilio WhatsApp → POST /webhook → handleMessage() → sendWhatsApp()
```

The webhook responds `200` immediately (before async work) to prevent Twilio retries and double messages.

### State machine (booking flow)

`handleMessage()` is a state machine driven entirely by Node.js. States in order:

`idle` → `name` → `service` → `barber` → `date` → `slot` → (reset to `idle`)

Each state shows numbered options; the user replies with a number. No AI parsing needed for the booking flow. Sessions are stored in-memory (`sessions` object) and expire after 30 minutes of inactivity.

**Groq (llama-3.1-8b-instant) is only called** when `state === 'idle'` and the message is not a greeting or booking keyword — i.e., general questions about the business.

### Key data flow

- `getBusinessInfo(businessId)` — fetches business, active barbers, active services from Supabase
- `getAvailableSlots(barberId, date)` — checks `schedules` table for work hours, then subtracts existing `appointments`
- `getNextAvailableDays(barberId, n)` — calls `getAvailableSlots` for the next 30 days, returns first `n` with availability
- `createAppointment(data)` — inserts into `appointments` table; appointment immediately visible in the dashboard

### Supabase tables used

| Table | Purpose |
|---|---|
| `twilio_settings` | Maps active Twilio number → `business_id` |
| `businesses` | Business info including `whatsapp_booking_link` |
| `barbers` | Active barbers per business |
| `services` | Active services with price and duration |
| `schedules` | Barber work hours by `day_of_week` (0=Sun, 6=Sat) |
| `appointments` | Booked slots; bot inserts here on confirmation |

### Environment variables

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Service role key (bypasses RLS) |
| `TWILIO_ACCOUNT_SID` | Twilio account |
| `TWILIO_AUTH_TOKEN` | Twilio auth |
| `TWILIO_WHATSAPP_FROM` | Sender number e.g. `whatsapp:+19392983515` |
| `GROQ_API_KEY` | Groq API key for llama-3.1-8b-instant |
| `PORT` | Must be set explicitly to `3000` in Railway (auto-assigned port causes 502) |

### Deployment (Railway)

- Node.js 22 required — Supabase realtime-js needs native WebSocket
- `NIXPACKS_NODE_VERSION=22` must be set in Railway variables
- `PORT=3000` must be set explicitly
- Twilio webhook URL: `https://barberbot-production-d3ca.up.railway.app/webhook`

### Supabase project

Project ref: `cqszqdgoteagffdnecju`  
MCP configured for this project — Supabase tools available in Claude Code sessions.

⚠️ `twilio_settings` and `marketing_campaigns` tables have RLS disabled.
