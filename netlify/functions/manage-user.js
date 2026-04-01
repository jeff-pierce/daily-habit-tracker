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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
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

  let callerUserId;
  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${token}`
      }
    });
    if (!userResponse.ok) {
      return json(401, { error: 'Invalid or expired session' });
    }
    const user = await userResponse.json();
    callerUserId = user?.id;
    if (!callerUserId) {
      return json(401, { error: 'Could not identify caller' });
    }
  } catch {
    return json(401, { error: 'Could not verify session' });
  }

  // Verify caller is admin
  try {
    const profileResponse = await fetch(
      `${supabaseUrl}/rest/v1/dht_profiles?user_id=eq.${encodeURIComponent(callerUserId)}&select=role`,
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
  } catch {
    return json(500, { error: 'Could not verify admin status' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid request body' });
  }

  const { action, targetUserId } = payload;

  if (!action || !targetUserId) {
    return json(400, { error: 'action and targetUserId are required' });
  }

  // Prevent admins from acting on themselves
  if (targetUserId === callerUserId && action !== 'enable') {
    return json(400, { error: 'Cannot perform this action on your own account' });
  }

  const adminHeaders = {
    'Content-Type': 'application/json',
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`
  };

  if (action === 'disable') {
    try {
      // Ban the auth user (effectively permanent — 100 years)
      const banRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(targetUserId)}`, {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({ ban_duration: '876000h' })
      });
      if (!banRes.ok) {
        const err = await banRes.json().catch(() => ({}));
        return json(500, { error: err.msg || err.message || 'Failed to ban user in auth' });
      }

      // Force sign out all existing sessions
      await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(targetUserId)}/logout`, {
        method: 'POST',
        headers: adminHeaders
      }).catch(() => {}); // non-fatal if endpoint unavailable

      // Mark disabled in profile
      await fetch(
        `${supabaseUrl}/rest/v1/dht_profiles?user_id=eq.${encodeURIComponent(targetUserId)}`,
        {
          method: 'PATCH',
          headers: { ...adminHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ disabled: true })
        }
      );

      return json(200, { ok: true });
    } catch (err) {
      return json(500, { error: err.message || 'Could not disable user' });
    }
  }

  if (action === 'enable') {
    try {
      // Unban the auth user
      const unbanRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(targetUserId)}`, {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({ ban_duration: 'none' })
      });
      if (!unbanRes.ok) {
        const err = await unbanRes.json().catch(() => ({}));
        return json(500, { error: err.msg || err.message || 'Failed to unban user in auth' });
      }

      // Mark enabled in profile
      await fetch(
        `${supabaseUrl}/rest/v1/dht_profiles?user_id=eq.${encodeURIComponent(targetUserId)}`,
        {
          method: 'PATCH',
          headers: { ...adminHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ disabled: false })
        }
      );

      return json(200, { ok: true });
    } catch (err) {
      return json(500, { error: err.message || 'Could not enable user' });
    }
  }

  if (action === 'delete') {
    try {
      // Delete from auth — cascades to dht_profiles, dht_logs, dht_habits via ON DELETE CASCADE
      const deleteRes = await fetch(
        `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(targetUserId)}`,
        {
          method: 'DELETE',
          headers: adminHeaders
        }
      );
      if (!deleteRes.ok) {
        const err = await deleteRes.json().catch(() => ({}));
        return json(500, { error: err.msg || err.message || 'Failed to delete user' });
      }

      return json(200, { ok: true });
    } catch (err) {
      return json(500, { error: err.message || 'Could not delete user' });
    }
  }

  return json(400, { error: `Unknown action: ${action}` });
};
