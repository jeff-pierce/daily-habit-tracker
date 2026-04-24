const RESEND_API_URL = 'https://api.resend.com/emails';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const NY_TZ = 'America/New_York';
const SUBJECT = 'Summary of Last Weeks Daily Habits';

const WRITING_PROMPT = `You are writing a short Monday morning reflection email for Jeff. Jeff is a first-time entrepreneur running a leadership development company. He logs daily wins and learnings throughout the week - a mix of work activity (LinkedIn outreach, calls booked, coding projects) and personal life (family, personal habits, mindset). Treat both as equally valid and weave them together naturally.
Your job is to write 150-200 words that help Jeff start his week with clarity and momentum.
Structure:

Opening line - Read the week and use judgment. If something specific and earned stands out, lead with that. If it was a steady, heads-down week, just say so cleanly. One sentence.
Momentum - 3-4 sentences capturing what he did and how it felt. Specific. Weave work and life together where it makes sense. Celebratory but not hollow.
Themes - Surface 1-3 recurring patterns from his learnings. Use his own words where possible - don't reframe or soften them. The goal is for Jeff to recognize what he already said, not hear a coach's interpretation of it. Each theme is 1-2 sentences.
Closing line - One sentence. Energizing but grounded. Not generic.

Tone: Direct, warm, human. No corporate language. No filler phrases like \"it's clear that\" or \"remember that.\" Write like a sharp friend who's been paying attention.
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
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(dt);
}

function addDaysIso(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return toIsoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function getWeekWindowForLastMondayRun(now = new Date()) {
  const ny = getDatePartsInTz(now, NY_TZ);
  const nyIso = toIsoDate(ny.year, ny.month, ny.day);

  const [y, m, d] = nyIso.split('-').map(Number);
  const nyDateUtc = new Date(Date.UTC(y, m - 1, d));
  const dow = nyDateUtc.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;

  const currentMonday = addDaysIso(nyIso, -daysSinceMonday);
  const weekStart = addDaysIso(currentMonday, -7);
  const weekEnd = addDaysIso(weekStart, 6);

  return { weekStart, weekEnd };
}

function isMonday8amNewYork(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ,
    weekday: 'long',
    hour: '2-digit',
    hour12: false
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = parts.find((p) => p.type === 'hour')?.value;

  return weekday === 'Monday' && hour === '08';
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
  const res = await fetch(`${supabaseUrl}/rest/v1/dht_habits?user_id=eq.${encodeURIComponent(userId)}&select=*&order=sort_order.asc&limit=${limit}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch habits: ${res.status}`);
  }
  const habits = await res.json();
  return Array.isArray(habits) ? habits.filter(h => h.visible !== false) : [];
}

function buildDynamicMetrics(habits, logs) {
  const weekLogs = Array.isArray(logs) ? logs : [];
  const metrics = {};

  habits.forEach((habit) => {
    const habitId = habit.id;
    const values = weekLogs.map((l) => l?.values?.[habitId]).filter((v) => v !== undefined && v !== null);

    if (habit.type === 'toggle') {
      metrics[habitId] = values.filter((v) => v === true).length;
    } else if (habit.type === 'counter') {
      metrics[habitId] = values.reduce((sum, v) => sum + (Number(v) || 0), 0);
    } else if (habit.type === 'slider') {
      metrics[habitId] = values.length
        ? (values.reduce((sum, v) => sum + (Number(v) || 0), 0) / values.length).toFixed(1)
        : null;
    } else if (habit.type === 'mood') {
      const nums = values.map(Number).filter(Number.isFinite);
      metrics[habitId] = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1) : null;
    } else if (habit.type === 'text') {
      metrics[habitId] = values.filter((v) => typeof v === 'string' && v.trim()).length;
    } else if (habit.type === 'gratitude') {
      metrics[habitId] = values.filter((v) => Array.isArray(v) && v.length > 0).length;
    }
  });

  const daysLogged = new Set(weekLogs.map((l) => l.log_date)).size;
  return { metrics, daysLogged };
}

function formatHabitMetricLine(habit, metricValue) {
  if (metricValue === null || metricValue === undefined) return null;

  const unit = habit.unit || '';
  const unitStr = unit ? ` ${unit}` : '';

  switch (habit.type) {
    case 'toggle':
      return `- ${habit.name}: ${metricValue} / 7 days`;
    case 'counter':
      return `- ${habit.name}: ${metricValue.toLocaleString()}${unitStr}`;
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

function buildMetricsLines(habits, metricsObj) {
  const lines = [];
  habits.forEach((habit) => {
    const metricValue = metricsObj.metrics[habit.id];
    const line = formatHabitMetricLine(habit, metricValue);
    if (line) lines.push(line);
  });
  lines.push(`- Days logged: ${metricsObj.daysLogged} / 7`);
  return lines;
}

function countActiveDays(logs) {
  const activeDates = new Set();
  for (const log of (logs || [])) {
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

function buildFallbackSummary(metrics, wins, learnings) {
  const themes = [];
  if (metrics.daysLogged >= 6) themes.push('Consistency carried the week.');
  else if (metrics.daysLogged >= 4) themes.push('You stayed in the game even when days got full.');
  else themes.push('This week had gaps, which is useful signal for planning a simpler baseline.');

  if (wins.length) themes.push(`Wins captured: ${wins.length}. Keep repeating what made those possible.`);
  if (learnings.length) themes.push(`Learnings captured: ${learnings.length}. Use them to shape one tighter plan this week.`);

  return [
    'You kept building this week, and the data shows where momentum is real.',
    ...themes,
    'Start this week by protecting one high-impact action each day and keep your wins/learnings brutally honest.'
  ].join(' ');
}

async function generateClaudeSummary({ anthropicKey, model, weekStart, weekEnd, metricsLines, wins, learnings }) {
  const userPrompt = [
    'Use the instructions exactly.',
    `Week covered: ${weekStart} to ${weekEnd} (America/New_York).`,
    '',
    'This Week metrics:',
    ...metricsLines,
    '',
    'Wins entries (raw):',
    ...(wins.length ? wins : ['- none logged']),
    '',
    'Learnings entries (raw):',
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
      max_tokens: 520,
      temperature: 0.6,
      system: WRITING_PROMPT,
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

  if (!text) {
    throw new Error('Claude returned empty summary');
  }

  return text;
}

async function generateSummaryWithRetry(args) {
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const summaryText = await generateClaudeSummary(args);
      return {
        summaryText,
        attempts: attempt
      };
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
    }
  }

  throw new Error(`Claude failed after ${maxAttempts} attempts: ${lastError?.message || 'Unknown error'}`);
}

function buildEmailHtml({ weekStart, weekEnd, metricsLines, summaryText }) {
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.55;color:#111827;max-width:640px">
      <h2 style="margin:0 0 12px;font-size:20px">Metrics</h2>
      <p style="margin:0 0 10px;color:#6b7280;font-size:14px">This Week table as of Sunday 11:30 PM America/New_York (${formatIsoDateHuman(weekStart)} - ${formatIsoDateHuman(weekEnd)})</p>
      <ul style="margin:0 0 20px 18px;padding:0">${metricsLines.map((line) => `<li style="margin:0 0 6px">${line.replace(/^-\s*/, '')}</li>`).join('')}</ul>
      <h2 style="margin:0 0 12px;font-size:20px">Summary</h2>
      <div style="white-space:pre-wrap">${summaryText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
    </div>
  `;
}

function buildEmailText({ weekStart, weekEnd, metricsLines, summaryText }) {
  return [
    'Metrics',
    `This Week table as of Sunday 11:30 PM America/New_York (${formatIsoDateHuman(weekStart)} - ${formatIsoDateHuman(weekEnd)})`,
    ...metricsLines,
    '',
    'Summary',
    summaryText
  ].join('\n');
}

async function sendEmail({ resendKey, fromEmail, toEmail, html, text }) {
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resendKey}`
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      subject: SUBJECT,
      html,
      text
    })
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.message || 'Failed to send weekly summary email');
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
    return json(500, { error: 'Missing required environment variables for weekly summaries' });
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

  if (!forceRun && !isMonday8amNewYork()) {
    return json(200, { ok: true, skipped: true, reason: 'Not Monday 8 AM America/New_York' });
  }

  const { weekStart, weekEnd } = getWeekWindowForLastMondayRun();

  try {
    let profilesQuery = 'dht_profiles?select=user_id,email,weekly_summary_enabled&weekly_summary_enabled=eq.true';
    if (targetEmail) {
      profilesQuery += `&email=eq.${encodeURIComponent(targetEmail)}`;
    }
    const profiles = await supabaseGet(
      supabaseUrl,
      serviceRoleKey,
      profilesQuery
    );

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
          `dht_logs?select=log_date,values&user_id=eq.${encodeURIComponent(userId)}&log_date=gte.${weekStart}&log_date=lte.${weekEnd}&order=log_date.asc`
        );

        if (countActiveDays(logs) < 3) continue;

        // Fetch user's top 6 habits
        const topHabits = await getTopHabitsForUser(supabaseUrl, serviceRoleKey, userId, 6);

        const jobRows = await supabasePost(supabaseUrl, serviceRoleKey, 'dht_email_jobs', {
          user_id: userId,
          email,
          job_type: 'weekly_summary',
          job_status: 'processing',
          scheduled_for: new Date().toISOString(),
          payload: {
            week_start: weekStart,
            week_end: weekEnd,
            summary_source: 'pending',
            claude_attempts: 0,
            claude_error: null
          }
        });
        jobId = Array.isArray(jobRows) ? jobRows[0]?.id : null;

        const metricsObj = buildDynamicMetrics(topHabits, logs);
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
              weekStart,
              weekEnd,
              metricsLines,
              wins,
              learnings
            });
            summaryText = generated.summaryText;
            claudeAttempts = generated.attempts;
          } catch (error) {
            summarySource = 'fallback';
            claudeError = (error?.message || 'Claude summary failed').slice(0, 500);
            summaryText = buildFallbackSummary(metrics, wins, learnings);
          }
        } else {
          summarySource = 'fallback';
          claudeError = 'ANTHROPIC_API_KEY missing; fallback summary used';
          summaryText = buildFallbackSummary(metrics, wins, learnings);
        }

        const html = buildEmailHtml({ weekStart, weekEnd, metricsLines, summaryText });
        const text = buildEmailText({ weekStart, weekEnd, metricsLines, summaryText });

        await sendEmail({
          resendKey,
          fromEmail,
          toEmail: email,
          html,
          text
        });

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
                week_start: weekStart,
                week_end: weekEnd,
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

    return json(200, {
      ok: true,
      weekStart,
      weekEnd,
      sentCount,
      failedCount
    });
  } catch (error) {
    return json(500, { error: error.message || 'Weekly summary run failed' });
  }
};

// Run at the top of each hour on Mondays (UTC), then gate to 8:00 AM America/New_York in code.
exports.config = {
  schedule: '0 * * * 1'
};
