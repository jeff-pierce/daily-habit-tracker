const RESEND_API_URL = 'https://api.resend.com/emails';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const NY_TZ = 'America/New_York';

const MONTHLY_WRITING_PROMPT = `You are writing a short first-of-the-month reflection email for Jeff. Jeff is a first-time entrepreneur running a leadership development company. He logs daily wins and learnings throughout each month — a mix of work activity (LinkedIn outreach, calls booked, coding projects) and personal life (family, personal habits, mindset). Treat both as equally valid and weave them together naturally.
Your job is to write 200-260 words that help Jeff start the new month with clarity about where he's been and intentionality about where he's going.
Structure:

Opening line - Read the month and use judgment. If there was a defining shift or breakthrough, lead with that. If it was a grinding, heads-down month, just say so cleanly. One sentence.
The arc - 4-5 sentences capturing the shape of the month. Not a laundry list of events — look for momentum, setbacks, pivots, and what changed between day 1 and day 30. Weave work and life together naturally.
Patterns - Surface 2-3 recurring themes from his learnings across all the weeks. Use his own words where possible. Help him see what he kept returning to, not a coach's reframe. Each theme is 1-2 sentences.
One thing to carry forward - A single sentence. Something specific from the month worth doubling down on in the one ahead. Not generic advice — something earned from his actual data.

Tone: Direct, warm, human. No corporate language. No filler phrases like "it's clear that" or "remember that." Write like a sharp friend who's been paying close attention for a whole month.
Do not add a subject line, greeting, or sign-off. Just the body.`;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function getHeader(headers, key) {
  if (!headers) return undefined;
  const lowerKey = key.toLowerCase();
  const found = Object.keys(headers).find((k) => k.toLowerCase() === lowerKey);
  return found ? headers[found] : undefined;
}

function getDatePartsInTz(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const day = Number(parts.find((p) => p.type === 'day')?.value);
  return { year, month, day };
}

function toIsoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatIsoDateHuman(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(dt);
}

function getMonthName(isoDate) {
  const [y, m] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, 1));
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(dt);
}

// Returns the date range for the previous calendar month in NY time.
// When called on the 1st, "previous month" = just-ended month.
function getPreviousMonthWindow(now = new Date()) {
  const ny = getDatePartsInTz(now, NY_TZ);
  // Last day of previous month = day 0 of current month
  const lastDay = new Date(Date.UTC(ny.year, ny.month - 1, 0));
  const monthEnd = toIsoDate(lastDay.getUTCFullYear(), lastDay.getUTCMonth() + 1, lastDay.getUTCDate());
  // First day of previous month
  const firstDay = new Date(Date.UTC(lastDay.getUTCFullYear(), lastDay.getUTCMonth(), 1));
  const monthStart = toIsoDate(firstDay.getUTCFullYear(), firstDay.getUTCMonth() + 1, firstDay.getUTCDate());

  return { monthStart, monthEnd };
}

function isFirstOfMonth8amNewYork(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    day: '2-digit',
    hour: '2-digit',
    hour12: false
  }).formatToParts(now);

  const day = parts.find((p) => p.type === 'day')?.value;
  const hour = parts.find((p) => p.type === 'hour')?.value;

  return day === '01' && hour === '08';
}

async function supabaseGet(supabaseUrl, serviceRoleKey, pathAndQuery) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    }
  });
  if (!res.ok) {
    throw new Error(`Supabase GET failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function supabasePost(supabaseUrl, serviceRoleKey, table, payload, prefer = 'return=representation') {
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: prefer,
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    throw new Error(`Supabase POST failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function supabasePatch(supabaseUrl, serviceRoleKey, tableWithFilters, payload) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${tableWithFilters}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    throw new Error(`Supabase PATCH failed (${res.status}): ${await res.text()}`);
  }
}

async function getTopHabitsForUser(supabaseUrl, serviceRoleKey, userId, limit = 6) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/dht_habits?user_id=eq.${encodeURIComponent(userId)}&select=*&order=sort_order.asc&limit=${limit}`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      }
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch habits: ${res.status}`);
  }
  const habits = await res.json();
  return Array.isArray(habits) ? habits.filter((h) => h.visible !== false) : [];
}

function buildDynamicMetrics(habits, logs, daysInMonth) {
  const monthLogs = Array.isArray(logs) ? logs : [];
  const metrics = {};

  habits.forEach((habit) => {
    const habitId = habit.id;
    const values = monthLogs.map((l) => l?.values?.[habitId]).filter((v) => v !== undefined && v !== null);

    if (habit.type === 'toggle') {
      metrics[habitId] = values.filter((v) => v === true).length;
    } else if (habit.type === 'counter') {
      metrics[habitId] = values.reduce((sum, v) => sum + (Number(v) || 0), 0);
    } else if (habit.type === 'slider') {
      const nums = values.map(Number).filter(Number.isFinite).filter((v) => v > 0);
      metrics[habitId] = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1) : null;
    } else if (habit.type === 'mood') {
      const nums = values.map(Number).filter(Number.isFinite);
      metrics[habitId] = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1) : null;
    } else if (habit.type === 'text') {
      metrics[habitId] = values.filter((v) => typeof v === 'string' && v.trim()).length;
    } else if (habit.type === 'gratitude') {
      metrics[habitId] = values.filter((v) => Array.isArray(v) && v.length > 0).length;
    }
  });

  const daysLogged = new Set(monthLogs.map((l) => l.log_date)).size;
  return { metrics, daysLogged, daysInMonth };
}

function formatHabitMetricLine(habit, metricValue, daysInMonth) {
  if (metricValue === null || metricValue === undefined) return null;

  const unit = habit.unit || '';
  const unitStr = unit ? ` ${unit}` : '';

  switch (habit.type) {
    case 'toggle':
      return `- ${habit.name}: ${metricValue} / ${daysInMonth} days`;
    case 'counter':
      return `- ${habit.name}: ${Number(metricValue).toLocaleString()}${unitStr} total`;
    case 'slider':
      return `- ${habit.name}: avg ${metricValue}${unitStr}`;
    case 'mood':
      return `- ${habit.name}: avg ${metricValue} / 5`;
    case 'text':
      return `- ${habit.name}: ${metricValue} entries`;
    case 'gratitude':
      return `- ${habit.name}: ${metricValue} logged`;
    default:
      return null;
  }
}

function buildMetricsLines(habits, metricsObj) {
  const lines = [];
  habits.forEach((habit) => {
    const metricValue = metricsObj.metrics[habit.id];
    const line = formatHabitMetricLine(habit, metricValue, metricsObj.daysInMonth);
    if (line) lines.push(line);
  });
  lines.push(`- Days logged: ${metricsObj.daysLogged} / ${metricsObj.daysInMonth}`);
  return lines;
}

function collectTextEntries(logs, key) {
  return (logs || [])
    .map((l) => {
      const raw = l?.values?.[key];
      if (typeof raw !== 'string') return null;
      const text = raw.trim();
      if (!text) return null;
      return `${l.log_date}: ${text}`;
    })
    .filter(Boolean);
}

function countActiveDays(logs) {
  const activeDates = new Set();
  for (const log of logs || []) {
    const values = log?.values;
    if (!values || typeof values !== 'object') continue;
    const isActive = Object.values(values).some((v) => {
      if (v === true) return true;
      if (typeof v === 'number' && v > 0) return true;
      if (typeof v === 'string' && v.trim() !== '') return true;
      if (Array.isArray(v) && v.length > 0) return true;
      return false;
    });
    if (isActive) activeDates.add(log.log_date);
  }
  return activeDates.size;
}

function buildFallbackSummary(metricsObj, wins, learnings, monthName) {
  const themes = [];
  const pct = metricsObj.daysLogged / metricsObj.daysInMonth;
  if (pct >= 0.8) themes.push(`Consistency was a real strength in ${monthName} — ${metricsObj.daysLogged} days logged out of ${metricsObj.daysInMonth}.`);
  else if (pct >= 0.5) themes.push(`You stayed engaged through most of ${monthName}, with ${metricsObj.daysLogged} days logged.`);
  else themes.push(`${monthName} had gaps. That's honest signal for what needs to change in the month ahead.`);

  if (wins.length) themes.push(`${wins.length} wins captured across the month. Worth reviewing what made those possible.`);
  if (learnings.length) themes.push(`${learnings.length} learnings logged. The patterns in those are worth carrying into ${monthName.split(' ')[0] === monthName ? 'next month' : 'the month ahead'}.`);

  return [
    `${monthName} is in the books.`,
    ...themes,
    'Use the data to set one tighter intention for this month — something measurable and within your control.'
  ].join(' ');
}

async function generateClaudeSummary({ anthropicKey, model, monthStart, monthEnd, monthName, metricsLines, wins, learnings }) {
  const userPrompt = [
    'Use the instructions exactly.',
    `Month covered: ${monthStart} to ${monthEnd} (${monthName}, America/New_York).`,
    '',
    'Monthly metrics:',
    ...metricsLines,
    '',
    'Wins entries (raw, chronological):',
    ...(wins.length ? wins : ['- none logged']),
    '',
    'Learnings entries (raw, chronological):',
    ...(learnings.length ? learnings : ['- none logged']),
    '',
    'Return only the reflection body.'
  ].join('\n');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      temperature: 0.65,
      system: MONTHLY_WRITING_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  const body = await response.json();
  if (!response.ok) {
    const errorDetail = body?.error?.message || body?.error?.type || body?.message || 'Unknown Claude error';
    throw new Error(`Claude API failed (${response.status}): ${errorDetail}`);
  }

  const text = (body?.content || [])
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();

  if (!text) throw new Error('Claude returned empty summary');
  return text;
}

async function generateSummaryWithRetry(args) {
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const summaryText = await generateClaudeSummary(args);
      return { summaryText, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
    }
  }
  throw new Error(`Claude failed after ${maxAttempts} attempts: ${lastError?.message || 'Unknown error'}`);
}

function buildEmailHtml({ monthStart, monthEnd, monthName, metricsLines, summaryText }) {
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.55;color:#111827;max-width:640px">
      <h2 style="margin:0 0 12px;font-size:20px">Monthly Metrics</h2>
      <p style="margin:0 0 10px;color:#6b7280;font-size:14px">${monthName} (${formatIsoDateHuman(monthStart)} – ${formatIsoDateHuman(monthEnd)})</p>
      <ul style="margin:0 0 20px 18px;padding:0">${metricsLines.map((line) => `<li style="margin:0 0 6px">${line.replace(/^-\s*/, '')}</li>`).join('')}</ul>
      <h2 style="margin:0 0 12px;font-size:20px">Monthly Summary</h2>
      <div style="white-space:pre-wrap">${summaryText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
    </div>
  `;
}

function buildEmailText({ monthStart, monthEnd, monthName, metricsLines, summaryText }) {
  return [
    'Monthly Metrics',
    `${monthName} (${formatIsoDateHuman(monthStart)} – ${formatIsoDateHuman(monthEnd)})`,
    ...metricsLines,
    '',
    'Monthly Summary',
    summaryText
  ].join('\n');
}

async function sendEmail({ resendKey, fromEmail, toEmail, subject, html, text }) {
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resendKey}`
    },
    body: JSON.stringify({ from: fromEmail, to: [toEmail], subject, html, text })
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.message || 'Failed to send monthly summary email');
  }
}

exports.handler = async (event) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const claudeModel = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';

  if (!supabaseUrl || !serviceRoleKey || !resendKey || !fromEmail) {
    return json(500, { error: 'Missing required environment variables for monthly summaries' });
  }

  const headers = event.headers || {};
  const isScheduledEvent = getHeader(headers, 'x-nf-event') === 'schedule' || !!getHeader(headers, 'x-nf-scheduled-at');
  const forceRun = String(event?.queryStringParameters?.force || '').toLowerCase() === 'true';
  const targetEmail = (event?.queryStringParameters?.target_email || '').trim().toLowerCase();

  if (!isScheduledEvent) {
    if (event.httpMethod !== 'POST') {
      return json(405, { error: 'Method not allowed' });
    }

    const manualSecret = process.env.WEEKLY_SUMMARY_SECRET;
    if (manualSecret) {
      const providedSecret = getHeader(headers, 'x-weekly-secret');
      if (!providedSecret || providedSecret !== manualSecret) {
        return json(401, { error: 'Unauthorized manual invocation' });
      }
    }
  }

  if (!forceRun && !isFirstOfMonth8amNewYork()) {
    return json(200, { ok: true, skipped: true, reason: 'Not the 1st of the month at 8 AM America/New_York' });
  }

  const { monthStart, monthEnd } = getPreviousMonthWindow();
  const monthName = getMonthName(monthStart);

  // Days in the previous month
  const [y, m] = monthStart.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const subject = `Your ${monthName} Habit Summary`;

  try {
    let profilesQuery = 'dht_profiles?select=user_id,email,weekly_summary_enabled&weekly_summary_enabled=eq.true';
    if (targetEmail) {
      profilesQuery += `&email=eq.${encodeURIComponent(targetEmail)}`;
    }
    const profiles = await supabaseGet(supabaseUrl, serviceRoleKey, profilesQuery);

    let sentCount = 0;
    let failedCount = 0;

    for (const profile of profiles) {
      const userId = profile.user_id;
      const email = (profile.email || '').trim().toLowerCase();
      if (!userId || !email) continue;

      let jobId = null;
      try {
        const logs = await supabaseGet(
          supabaseUrl,
          serviceRoleKey,
          `dht_logs?select=log_date,values&user_id=eq.${encodeURIComponent(userId)}&log_date=gte.${monthStart}&log_date=lte.${monthEnd}&order=log_date.asc`
        );

        // Skip users with fewer than 7 active days in the month
        if (countActiveDays(logs) < 7) continue;

        const topHabits = await getTopHabitsForUser(supabaseUrl, serviceRoleKey, userId, 6);

        const jobRows = await supabasePost(supabaseUrl, serviceRoleKey, 'dht_email_jobs', {
          user_id: userId,
          email,
          job_type: 'monthly_summary',
          job_status: 'processing',
          scheduled_for: new Date().toISOString(),
          payload: {
            month_start: monthStart,
            month_end: monthEnd,
            summary_source: 'pending',
            claude_attempts: 0,
            claude_error: null
          }
        });
        jobId = Array.isArray(jobRows) ? jobRows[0]?.id : null;

        const metricsObj = buildDynamicMetrics(topHabits, logs, daysInMonth);
        const metricsLines = buildMetricsLines(topHabits, metricsObj);
        const wins = collectTextEntries(logs, 'wins');
        const learnings = collectTextEntries(logs, 'learnings');

        let summaryText;
        let summarySource = 'claude';
        let claudeAttempts = 0;
        let claudeError = null;

        if (anthropicKey) {
          try {
            const generated = await generateSummaryWithRetry({
              anthropicKey,
              model: claudeModel,
              monthStart,
              monthEnd,
              monthName,
              metricsLines,
              wins,
              learnings
            });
            summaryText = generated.summaryText;
            claudeAttempts = generated.attempts;
          } catch (error) {
            summarySource = 'fallback';
            claudeError = (error?.message || 'Claude summary failed').slice(0, 500);
            summaryText = buildFallbackSummary(metricsObj, wins, learnings, monthName);
          }
        } else {
          summarySource = 'fallback';
          claudeError = 'ANTHROPIC_API_KEY missing; fallback summary used';
          summaryText = buildFallbackSummary(metricsObj, wins, learnings, monthName);
        }

        const html = buildEmailHtml({ monthStart, monthEnd, monthName, metricsLines, summaryText });
        const text = buildEmailText({ monthStart, monthEnd, monthName, metricsLines, summaryText });

        await sendEmail({ resendKey, fromEmail, toEmail: email, subject, html, text });

        if (jobId) {
          await supabasePatch(
            supabaseUrl,
            serviceRoleKey,
            `dht_email_jobs?id=eq.${encodeURIComponent(jobId)}`,
            {
              job_status: 'sent',
              sent_at: new Date().toISOString(),
              error_message: null,
              payload: {
                month_start: monthStart,
                month_end: monthEnd,
                summary_source: summarySource,
                claude_attempts: claudeAttempts,
                claude_error: claudeError
              }
            }
          );
        }

        sentCount += 1;
      } catch (error) {
        failedCount += 1;
        if (jobId) {
          await supabasePatch(
            supabaseUrl,
            serviceRoleKey,
            `dht_email_jobs?id=eq.${encodeURIComponent(jobId)}`,
            { job_status: 'failed', error_message: (error.message || 'Unknown failure').slice(0, 500) }
          );
        }
      }
    }

    return json(200, { ok: true, monthStart, monthEnd, sentCount, failedCount });
  } catch (error) {
    return json(500, { error: error.message || 'Monthly summary run failed' });
  }
};
