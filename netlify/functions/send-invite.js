const RESEND_API_URL = 'https://api.resend.com/emails';

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

function getBaseUrl(headers) {
  return headers['x-forwarded-proto'] && headers['x-forwarded-host']
    ? `${headers['x-forwarded-proto']}://${headers['x-forwarded-host']}`
    : process.env.PUBLIC_APP_URL;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  const adminEmail = process.env.ADMIN_EMAIL;

  if (!supabaseUrl || !serviceRoleKey || !resendKey || !fromEmail || !adminEmail) {
    return json(500, { error: 'Missing required environment variables' });
  }

  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) {
    return json(401, { error: 'Missing authorization header' });
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return json(401, { error: 'Invalid authorization header' });
  }

  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${token}`
      }
    });

    if (!userResponse.ok) {
      return json(401, { error: 'Unable to verify user session' });
    }

    const user = await userResponse.json();
    const profileResponse = await fetch(
      `${supabaseUrl}/rest/v1/dht_profiles?user_id=eq.${encodeURIComponent(user.id)}&select=email,role`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`
        }
      }
    );

    const profiles = await profileResponse.json();
    const profile = Array.isArray(profiles) ? profiles[0] : null;
    if (!profile || profile.role !== 'admin') {
      return json(403, { error: 'Admin access required' });
    }

    const payload = JSON.parse(event.body || '{}');
    const email = String(payload.email || '').trim().toLowerCase();
    const role = payload.role === 'admin' ? 'admin' : 'user';

    if (!email || !email.includes('@')) {
      return json(400, { error: 'A valid email is required' });
    }

    const inviteUpsert = await fetch(`${supabaseUrl}/rest/v1/dht_invites?on_conflict=email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      },
      body: JSON.stringify({
        email,
        invited_by: user.id,
        role,
        status: 'pending',
        resend_count: Number(payload.incrementResend) ? Number(payload.currentResendCount || 0) + 1 : 0,
        last_sent_at: new Date().toISOString()
      })
    });

    if (!inviteUpsert.ok) {
      const errorText = await inviteUpsert.text();
      return json(500, { error: 'Failed to save invite', details: errorText });
    }

    const inviteRows = await inviteUpsert.json();
    const invite = Array.isArray(inviteRows) ? inviteRows[0] : null;
    if (!invite) {
      return json(500, { error: 'Invite record missing after save' });
    }

    const baseUrl = getBaseUrl(event.headers);
    const redirectTo = `${baseUrl}/`;
    const otpResponse = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      },
      body: JSON.stringify({
        type: 'magiclink',
        email,
        options: {
          redirectTo
        }
      })
    });

    const otpData = await otpResponse.json();
    if (!otpResponse.ok) {
      return json(500, { error: otpData.msg || 'Failed to generate magic link' });
    }

    const actionLink = otpData.properties?.action_link;
    if (!actionLink) {
      return json(500, { error: 'Supabase did not return an action link' });
    }

    const appName = 'Daily Habits';
    const emailResponse = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        reply_to: adminEmail,
        subject: `You are invited to ${appName}`,
        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">
            <h2 style="margin-bottom:12px">You are invited to Daily Habits</h2>
            <p style="margin:0 0 12px">${profile.email} invited you to create a Daily Habits account.</p>
            <p style="margin:0 0 20px">Click the button below to sign in with your email and finish setting up your account.</p>
            <p style="margin:0 0 20px">
              <a href="${actionLink}" style="display:inline-block;padding:12px 18px;background:#5b50d6;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700">Create your account</a>
            </p>
            <p style="margin:0;color:#6b7280;font-size:14px">If the button does not work, use this link:</p>
            <p style="margin:8px 0 0;font-size:14px;word-break:break-all"><a href="${actionLink}">${actionLink}</a></p>
          </div>
        `
      })
    });

    const emailData = await emailResponse.json();
    if (!emailResponse.ok) {
      return json(500, { error: emailData.message || 'Failed to send invite email' });
    }

    return json(200, {
      ok: true,
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        status: invite.status,
        resend_count: invite.resend_count,
        last_sent_at: invite.last_sent_at
      }
    });
  } catch (error) {
    return json(500, { error: error.message || 'Unexpected error' });
  }
};
